// Safe WebUSB D4 credit-flow diagnostic.
// This file deliberately contains NO EEPROM write packet (0x42).

(() => {
  const btn = document.createElement('button');
  btn.id = 'credit-test';
  btn.textContent = 'Test D4 credit flow';

  const closeButton = document.querySelector('#close');
  const buttons = closeButton?.parentElement;
  if (buttons && closeButton) buttons.insertBefore(btn, closeButton);

  function dataBytes(result) {
    if (!result?.data) return new Uint8Array();
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }

  function containsReplyCode(data, code) {
    return (data.length >= 1 && data[0] === code) ||
           (data.length >= 7 && data[6] === code) ||
           data.includes(code);
  }

  async function sendAndRead(outEp, inEp, packet, label, expectedCode = null, requireExpected = false) {
    const readPromise = readWithTimeout(inEp, 512, 1500);
    await transferOutChecked(outEp, packet, label);
    const result = await readPromise;

    if (result.status !== 'ok') {
      throw new Error(`${label}: USB IN status=${result.status}.`);
    }

    const data = dataBytes(result);
    if (!data.length) throw new Error(`${label}: tomt USB-svar.`);

    log(`${label} ACK: ${data.length} bytes`);
    log(bytesToHex(data));

    if (expectedCode !== null) {
      const found = containsReplyCode(data, expectedCode);
      if (found) {
        log(`${label}: observerede ${hex(expectedCode)} i svaret.`);
      } else if (requireExpected) {
        throw new Error(`${label}: forventede D4 reply ${hex(expectedCode)}, men fandt den ikke i svaret.`);
      } else {
        log(`${label}: svar modtaget, men ${hex(expectedCode)} var ikke synlig i denne USB-frame. Fortsætter som den native EWR-executor, der kun kræver ACK-indhold på selve EEPROM-write-pakkerne.`);
      }
    }
  }

  btn.addEventListener('click', async () => {
    if (!device || claimedInterface === null || !selectedCandidate || !selectedModel) {
      log('FEJL: Klik først “Find Epson-printer”.');
      return;
    }

    btn.disabled = true;
    log('');
    log('Starter sikker D4 credit-flow test…');
    log('Denne test sender init, open-channel, credit grant og credit request. Den indeholder INGEN EEPROM-write-kommando (0x42).');
    log('Bemærk: EWR kræver ikke specifikke 0x83/0x84-koder på credit-pakkerne; den dræner blot det svar, der kommer.');

    const ejlInit = [
      0x00,0x00,0x00,0x1B,0x01,0x40,0x45,0x4A,0x4C,0x20,0x31,0x32,0x38,0x34,0x2E,0x34,0x0A,
      0x40,0x45,0x4A,0x4C,0x0A,0x40,0x45,0x4A,0x4C,0x0A
    ];
    const d4Init = [0x00,0x00,0x00,0x08,0x01,0x00,0x00,0x10];
    const d4Open = [0x00,0x00,0x00,0x11,0x01,0x00,0x01,0x02,0x02,0x01,0x00,0x01,0x00,0x00,0x00,0x00,0x00];
    const d4CreditGrant = [0x00,0x00,0x00,0x0B,0x01,0x00,0x03,0x02,0x02,0x00,0x01];
    const d4CreditReq = [0x00,0x00,0x00,0x0D,0x01,0x00,0x04,0x02,0x02,0xFF,0xFF,0x00,0x01];

    try {
      const outEp = selectedCandidate.bulkOut.endpointNumber;
      const inEp = selectedCandidate.bulkIn.endpointNumber;

      await transferOutChecked(outEp, ejlInit, 'EJL init');
      await sleep(40);
      await transferOutChecked(outEp, d4Init, 'D4 init');
      await sleep(40);

      await sendAndRead(outEp, inEp, d4Open, 'Open-channel', 0x81, true);
      await sleep(40);
      await sendAndRead(outEp, inEp, d4CreditGrant, 'Credit grant', 0x83, false);
      await sleep(40);
      await sendAndRead(outEp, inEp, d4CreditReq, 'Credit request', 0x84, false);

      log('D4 CREDIT TEST SUCCESS: Browseren kan gennemføre hele pre-write flowet. Ingen EEPROM-værdi er skrevet.');
      btn.disabled = false;
    } catch (err) {
      log(`FEJL i D4 credit-flow test: ${err?.name || 'Error'}: ${err?.message || err}`);
      log('Forbindelsen lukkes, så en eventuel ventende WebUSB-transfer afbrydes.');
      await closeDevice();
      btn.disabled = false;
    }
  });
})();
