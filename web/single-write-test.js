// First real EEPROM-write diagnostic for the WebUSB prototype.
// Safety scope: ET-2820 only, exactly ONE database-defined write, no retries.

(() => {
  const btn = document.querySelector('#single-write');
  if (!btn) return;

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

  async function sendAndReadOne(outEp, inEp, packet, label) {
    const readPromise = readWithTimeout(inEp, 512, 1500);
    await transferOutChecked(outEp, packet, label);
    const result = await readPromise;

    if (result.status !== 'ok') {
      throw new Error(`${label}: USB IN status=${result.status}.`);
    }

    const data = dataBytes(result);
    log(`${label} svar: ${data.length} bytes`);
    if (data.length) log(bytesToHex(data));
    return data;
  }

  async function readWriteAck(inEp, firstReadPromise) {
    let combined = new Uint8Array();

    for (let frame = 1; frame <= 4; frame++) {
      const result = frame === 1
        ? await firstReadPromise
        : await readWithTimeout(inEp, 512, 900);

      if (result.status !== 'ok') {
        throw new Error(`EEPROM ACK frame ${frame}: USB IN status=${result.status}.`);
      }

      const data = dataBytes(result);
      log(`EEPROM ACK frame ${frame}: ${data.length} bytes`);
      if (data.length) log(bytesToHex(data));
      combined = concatBytes(combined, data);

      if (containsToken(combined, NG_TOKEN)) {
        return { status: 'ng', data: combined };
      }
      if (containsToken(combined, OK_TOKEN)) {
        return { status: 'ok', data: combined };
      }
    }

    return { status: 'missing', data: combined };
  }

  btn.addEventListener('click', async () => {
    if (!device || claimedInterface === null || !selectedCandidate || !selectedModel) {
      log('FEJL: Klik først “Find Epson-printer”.');
      return;
    }

    if (selectedModel.name !== 'ET-2820') {
      log(`FEJL: Enkelt-write testen er sikkerhedslåst til ET-2820. Fundet model: ${selectedModel.name}.`);
      return;
    }

    const model = selectedModel.data;
    const group = Array.isArray(model.pad_groups) ? model.pad_groups[0] : null;
    const addresses = Array.isArray(group?.addresses) ? group.addresses : [];
    const resetValues = Array.isArray(group?.reset) ? group.reset : [];

    if (!group || !addresses.length || addresses.length !== resetValues.length) {
      log('FEJL: ET-2820 databaseposten har ikke en gyldig første pad-gruppe.');
      return;
    }

    // Deliberately use only the first database-defined write: Platen address 28 -> 0.
    const address = Number(addresses[0]);
    const value = Number(resetValues[0]);

    if (address !== 28 || value !== 0) {
      log(`FEJL: Sikkerhedstjek fejlede. Forventede ET-2820 første write adresse 28 -> 0, men databasen siger ${address} -> ${value}.`);
      return;
    }

    const confirmed = window.confirm(
      `ADVARSEL: Dette er en rigtig EEPROM-skrivning.\n\n` +
      `Model: ET-2820\n` +
      `Pad: ${group.desc || 'Platen Pad Counter'}\n` +
      `Adresse: ${address} (0x${address.toString(16).toUpperCase().padStart(4, '0')})\n` +
      `Værdi: ${value} (0x${value.toString(16).toUpperCase().padStart(2, '0')})\n\n` +
      `Der sendes præcis ÉN EEPROM-write-pakke og ingen retries. Fortsæt?`
    );
    if (!confirmed) {
      log('Enkelt EEPROM-write blev annulleret af brugeren.');
      return;
    }

    btn.disabled = true;
    log('');
    log('Starter test med ÉN rigtig EEPROM-skrivning…');
    log('Sikkerhedslås: ET-2820, Platen Pad Counter, adresse 28 (0x001C) -> 0 (0x00), ingen retries.');

    const ejlInit = [
      0x00,0x00,0x00,0x1B,0x01,0x40,0x45,0x4A,0x4C,0x20,0x31,0x32,0x38,0x34,0x2E,0x34,0x0A,
      0x40,0x45,0x4A,0x4C,0x0A,0x40,0x45,0x4A,0x4C,0x0A
    ];
    const d4Init = [0x00,0x00,0x00,0x08,0x01,0x00,0x00,0x10];
    const d4Open = [0x00,0x00,0x00,0x11,0x01,0x00,0x01,0x02,0x02,0x01,0x00,0x01,0x00,0x00,0x00,0x00,0x00];
    const d4CreditGrant = [0x00,0x00,0x00,0x0B,0x01,0x00,0x03,0x02,0x02,0x00,0x01];
    const d4CreditReq = [0x00,0x00,0x00,0x0D,0x01,0x00,0x04,0x02,0x02,0xFF,0xFF,0x00,0x01];
    const writePacket = generateWritePacket(Number(model.rkey), address, value, String(model.wkey));

    try {
      const outEp = selectedCandidate.bulkOut.endpointNumber;
      const inEp = selectedCandidate.bulkIn.endpointNumber;

      await transferOutChecked(outEp, ejlInit, 'EJL init');
      await sleep(40);
      await transferOutChecked(outEp, d4Init, 'D4 init');
      await sleep(40);

      await sendAndReadOne(outEp, inEp, d4Open, 'Open-channel');
      await sleep(40);
      await sendAndReadOne(outEp, inEp, d4CreditGrant, 'Credit grant');
      await sleep(40);
      await sendAndReadOne(outEp, inEp, d4CreditReq, 'Credit request');
      await sleep(40);

      log(`EEPROM write-pakke: ${writePacket.length} bytes`);
      log(bytesToHex(writePacket));

      const firstAckRead = readWithTimeout(inEp, 512, 1800);
      await transferOutChecked(outEp, writePacket, 'EEPROM WRITE adresse 28');
      const ack = await readWriteAck(inEp, firstAckRead);

      if (ack.status === 'ng') {
        log('EEPROM WRITE REJECTED: Printeren returnerede :42:NG;. Der sendes ikke mere.');
      } else if (ack.status === 'ok') {
        log('EEPROM WRITE VERIFIED: Printeren returnerede :42:OK;. Den ene skrivning er bekræftet.');
      } else {
        log('EEPROM WRITE IKKE BEKRÆFTET: :42:OK; eller :42:NG; blev ikke fundet. Der sendes ikke mere.');
      }
    } catch (err) {
      log(`FEJL i enkelt EEPROM-write test: ${err?.name || 'Error'}: ${err?.message || err}`);
      log('Der sendes ikke flere EEPROM-write-pakker.');
    } finally {
      await closeDevice();
      btn.disabled = false;
    }
  });
})();
