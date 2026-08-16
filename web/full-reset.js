// Full WebUSB EEPROM reset for Epson models in the local EWR database.
// This implementation mirrors the native EWR executor semantics:
// - EJL/D4 init and open
// - credit grant + credit request before each write
// - require :42:OK; for every EEPROM write
// - abort immediately on :42:NG;
// - retry an unacknowledged write up to 3 times, re-sending credit packets first

(() => {
  const closeButton = document.querySelector('#close');
  const buttons = closeButton?.parentElement;
  if (!buttons || !closeButton) return;

  const btn = document.createElement('button');
  btn.id = 'full-reset';
  btn.textContent = 'Udfør fuld reset';
  buttons.insertBefore(btn, closeButton);

  const OK_TOKEN = [0x3A,0x34,0x32,0x3A,0x4F,0x4B,0x3B]; // :42:OK;
  const NG_TOKEN = [0x3A,0x34,0x32,0x3A,0x4E,0x47,0x3B]; // :42:NG;

  function dataBytes(result) {
    if (!result?.data) return new Uint8Array();
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }

  function containsToken(data, token) {
    if (data.length < token.length) return false;
    outer: for (let i = 0; i <= data.length - token.length; i++) {
      for (let j = 0; j < token.length; j++) {
        if (data[i + j] !== token[j]) continue outer;
      }
      return true;
    }
    return false;
  }

  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function flattenWrites(model) {
    const writes = [];
    const groups = Array.isArray(model.pad_groups) ? model.pad_groups : [];

    for (const group of groups) {
      const addresses = Array.isArray(group.addresses) ? group.addresses : [];
      const resetValues = Array.isArray(group.reset) ? group.reset : [];

      if (addresses.length !== resetValues.length) {
        throw new Error(`${group.desc || group.kind || 'Pad group'}: addresses/reset har forskellig længde.`);
      }

      for (let i = 0; i < addresses.length; i++) {
        writes.push({
          group: group.desc || group.kind || 'Pad group',
          address: Number(addresses[i]),
          value: Number(resetValues[i]),
        });
      }
    }

    return writes;
  }

  btn.addEventListener('click', async () => {
    if (!device || claimedInterface === null || !selectedCandidate || !selectedModel) {
      log('FEJL: Klik først “Find Epson-printer”.');
      return;
    }

    const model = selectedModel.data;
    let writes;
    try {
      writes = flattenWrites(model);
    } catch (err) {
      log(`FEJL: ${err.message || err}`);
      return;
    }

    if (!writes.length) {
      log('FEJL: Den valgte model har ingen EEPROM-resetadresser.');
      return;
    }

    // Extra guard for the model used during development/testing.
    if (selectedModel.name === 'ET-2820') {
      const expectedAddresses = [28,52,53,54,55,255,47,48,49,50,51,252,253,254];
      const expectedValues = [0,0,0,94,94,94,0,0,0,0,0,0,0,0];
      const matches = writes.length === expectedAddresses.length && writes.every((w, i) =>
        w.address === expectedAddresses[i] && w.value === expectedValues[i]
      );
      if (!matches) {
        log('FEJL: ET-2820 sikkerhedstjek fejlede: databaseværdierne er ændret siden testen. Reset afbrydes.');
        return;
      }
    }

    const confirmed = window.confirm(
      `ADVARSEL: Dette udfører en rigtig EEPROM-reset.\n\n` +
      `Model: ${selectedModel.name}\n` +
      `EEPROM-skrivninger: ${writes.length}\n\n` +
      `Kør kun dette efter at waste ink pad/opsamling er blevet fysisk serviceret.\n` +
      `Hver skrivning skal bekræftes med :42:OK;. Ved fejl stoppes reset med det samme.\n\n` +
      `Fortsæt med fuld reset?`
    );
    if (!confirmed) {
      log('Fuld reset blev annulleret af brugeren.');
      return;
    }

    btn.disabled = true;
    const singleWriteBtn = document.querySelector('#single-write');
    if (singleWriteBtn) singleWriteBtn.disabled = true;

    log('');
    log('Starter FULD EEPROM-reset…');
    log(`Model: ${selectedModel.name}. EEPROM-skrivninger: ${writes.length}.`);
    log('Hver EEPROM-write skal returnere :42:OK;. :42:NG; eller tre manglende ACKs stopper processen.');

    const ejlInit = [
      0x00,0x00,0x00,0x1B,0x01,0x40,0x45,0x4A,0x4C,0x20,0x31,0x32,0x38,0x34,0x2E,0x34,0x0A,
      0x40,0x45,0x4A,0x4C,0x0A,0x40,0x45,0x4A,0x4C,0x0A
    ];
    const d4Init = [0x00,0x00,0x00,0x08,0x01,0x00,0x00,0x10];
    const d4Open = [0x00,0x00,0x00,0x11,0x01,0x00,0x01,0x02,0x02,0x01,0x00,0x01,0x00,0x00,0x00,0x00,0x00];
    const d4CreditGrant = [0x00,0x00,0x00,0x0B,0x01,0x00,0x03,0x02,0x02,0x00,0x01];
    const d4CreditReq = [0x00,0x00,0x00,0x0D,0x01,0x00,0x04,0x02,0x02,0xFF,0xFF,0x00,0x01];

    let stopReader = false;
    let rx = new Uint8Array();
    let rxFrame = 0;
    let readerError = null;
    let readerPromise = null;
    let verified = 0;
    let success = false;

    try {
      const outEp = selectedCandidate.bulkOut.endpointNumber;
      const inEp = selectedCandidate.bulkIn.endpointNumber;

      // One continuous BULK-IN reader proved necessary on macOS/WebUSB to preserve
      // the complete Epson D4 framing and reliably capture :42:OK;.
      readerPromise = (async () => {
        while (!stopReader && device?.opened) {
          try {
            const result = await device.transferIn(inEp, 512);
            if (result.status !== 'ok') {
              readerError = new Error(`Kontinuerlig USB IN: status=${result.status}.`);
              break;
            }

            const data = dataBytes(result);
            rxFrame++;
            if (data.length) {
              log(`USB IN frame ${rxFrame}: ${data.length} bytes`);
              log(bytesToHex(data));
              rx = concatBytes(rx, data);
            } else {
              await sleep(20);
            }
          } catch (err) {
            if (!stopReader) readerError = err;
            break;
          }
        }
      })();

      await transferOutChecked(outEp, ejlInit, 'EJL init');
      await sleep(100);
      await transferOutChecked(outEp, d4Init, 'D4 init');
      await sleep(100);
      await transferOutChecked(outEp, d4Open, 'Open-channel');
      await sleep(100);

      for (let index = 0; index < writes.length; index++) {
        const w = writes[index];
        const writePacket = generateWritePacket(Number(model.rkey), w.address, w.value, String(model.wkey));
        let confirmed = false;

        for (let attempt = 1; attempt <= 3; attempt++) {
          if (readerError) throw readerError;

          if (attempt > 1) {
            log(`Write ${index + 1}/${writes.length}: retry ${attempt}/3 — sender credit-pakker igen.`);
            await sleep(200);
          }

          await transferOutChecked(outEp, d4CreditGrant, `Credit grant ${index + 1}/${writes.length}`);
          await sleep(100);
          await transferOutChecked(outEp, d4CreditReq, `Credit request ${index + 1}/${writes.length}`);
          await sleep(100);

          if (readerError) throw readerError;

          // Only inspect bytes arriving after this particular write was sent.
          const writeRxStart = rx.length;
          log(`EEPROM write ${index + 1}/${writes.length}: ${w.group}, adresse ${w.address} (${hex(w.address, 4)}) -> ${w.value} (${hex(w.value)})`);
          await transferOutChecked(outEp, writePacket, `EEPROM WRITE ${index + 1}/${writes.length}`);

          const deadline = Date.now() + 3500;
          let ackStatus = 'missing';

          while (Date.now() < deadline) {
            if (readerError) throw readerError;
            const afterWrite = rx.slice(writeRxStart);

            if (containsToken(afterWrite, NG_TOKEN)) {
              ackStatus = 'ng';
              break;
            }
            if (containsToken(afterWrite, OK_TOKEN)) {
              ackStatus = 'ok';
              break;
            }
            await sleep(50);
          }

          if (ackStatus === 'ng') {
            throw new Error(`Printeren afviste EEPROM write ${index + 1}/${writes.length} med :42:NG;.`);
          }

          if (ackStatus === 'ok') {
            verified++;
            confirmed = true;
            log(`VERIFIED ${verified}/${writes.length}: :42:OK;`);
            break;
          }

          log(`Write ${index + 1}/${writes.length}: intet :42:OK; inden for 3,5 sekunder.`);
        }

        if (!confirmed) {
          throw new Error(`EEPROM write ${index + 1}/${writes.length} blev ikke bekræftet efter 3 forsøg.`);
        }

        await sleep(100);
      }

      success = verified === writes.length;
      if (!success) {
        throw new Error(`Kun ${verified}/${writes.length} EEPROM-skrivninger blev bekræftet.`);
      }

      log('');
      log(`RESET SUCCESS: ${verified}/${writes.length} EEPROM-skrivninger blev bekræftet med :42:OK;.`);
      log('Sluk printeren helt, vent et par sekunder, og tænd den igen.');
    } catch (err) {
      log('');
      log(`RESET STOPPET: ${err?.name || 'Error'}: ${err?.message || err}`);
      log(`Bekræftede EEPROM-skrivninger før stop: ${verified}/${writes.length}.`);
      log('Der sendes ikke flere EEPROM-write-pakker.');
    } finally {
      stopReader = true;
      await closeDevice();
      if (readerPromise) {
        try { await readerPromise; } catch (_) {}
      }
      btn.disabled = false;
      if (singleWriteBtn) singleWriteBtn.disabled = false;
    }
  });
})();
