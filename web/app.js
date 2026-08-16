const EPSON_VID = 0x04B8;

const connectBtn = document.querySelector('#connect');
const testBtn = document.querySelector('#test');
const closeBtn = document.querySelector('#close');
const logEl = document.querySelector('#log');

let device = null;
let claimedInterface = null;
let selectedCandidate = null;
let selectedModel = null;

function log(message = '') {
  logEl.textContent += `\n${message}`;
  logEl.scrollTop = logEl.scrollHeight;
}

function hex(n, width = 2) {
  return `0x${Number(n).toString(16).toUpperCase().padStart(width, '0')}`;
}

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

function describeEndpoint(endpoint) {
  return `${endpoint.direction.toUpperCase()} ${endpoint.type} endpoint #${endpoint.endpointNumber} (${hex(endpoint.endpointNumber)}) packetSize=${endpoint.packetSize}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeModelName(name) {
  return String(name || '')
    .replace(/\s+Series\s*$/i, '')
    .trim();
}

async function loadLocalModel(productName) {
  const response = await fetch('database.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Kunne ikke hente lokal database.json (HTTP ${response.status}).`);
  }

  const json = await response.json();
  const models = (json.models && typeof json.models === 'object') ? json.models : json;
  const wanted = normalizeModelName(productName);

  let key = Object.keys(models).find(k => k.toLowerCase() === wanted.toLowerCase());
  if (!key) {
    throw new Error(`Printermodellen '${wanted}' blev ikke fundet i den lokale database.`);
  }

  const model = models[key];
  const groups = Array.isArray(model.pad_groups) ? model.pad_groups : [];
  const writes = groups.reduce((sum, group) => sum + (Array.isArray(group.addresses) ? group.addresses.length : 0), 0);

  log('');
  log(`Lokal database: MATCH '${key}'.`);
  log(`rkey=${model.rkey}, wkey=${model.wkey}, pad_groups=${groups.length}, EEPROM writes=${writes}`);
  for (const group of groups) {
    const count = Array.isArray(group.addresses) ? group.addresses.length : 0;
    log(`- ${group.desc || group.kind || 'Pad group'}: ${count} skriveadresser`);
  }
  log('Databasen er kun læst. Ingen EEPROM-værdier er skrevet.');

  return { name: key, data: model };
}

function getCandidates(configuration) {
  const candidates = [];
  const seenInterfaces = new Set();
  const all = [];

  for (const iface of configuration.interfaces) {
    for (const alt of iface.alternates) {
      const bulkIn = alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
      const bulkOut = alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
      if (!bulkIn || !bulkOut) continue;

      const isPrinterClass = alt.interfaceClass === 0x07;
      const isVendorSpecific = alt.interfaceClass === 0xFF;
      if (!isPrinterClass && !isVendorSpecific) continue;

      all.push({
        interfaceNumber: iface.interfaceNumber,
        alternateSetting: alt.alternateSetting,
        interfaceClass: alt.interfaceClass,
        interfaceSubclass: alt.interfaceSubclass,
        interfaceProtocol: alt.interfaceProtocol,
        bulkIn,
        bulkOut,
        priority: isPrinterClass ? 0 : 1,
      });
    }
  }

  all.sort((a, b) =>
    a.priority - b.priority ||
    a.interfaceNumber - b.interfaceNumber ||
    a.alternateSetting - b.alternateSetting
  );

  for (const candidate of all) {
    if (seenInterfaces.has(candidate.interfaceNumber)) continue;
    seenInterfaces.add(candidate.interfaceNumber);
    candidates.push(candidate);
  }

  return candidates;
}

async function closeDevice() {
  if (!device) return;
  try {
    if (claimedInterface !== null) {
      try { await device.releaseInterface(claimedInterface); } catch (_) {}
    }
    if (device.opened) await device.close();
  } finally {
    device = null;
    claimedInterface = null;
    selectedCandidate = null;
    selectedModel = null;
    connectBtn.disabled = false;
    testBtn.disabled = true;
    closeBtn.disabled = true;
    log('Forbindelsen er lukket.');
  }
}

async function transferOutChecked(endpointNumber, bytes, label) {
  const result = await device.transferOut(endpointNumber, Uint8Array.from(bytes));
  if (result.status !== 'ok' || result.bytesWritten !== bytes.length) {
    throw new Error(`${label}: USB OUT fejlede (status=${result.status}, skrevet=${result.bytesWritten}/${bytes.length}).`);
  }
  log(`${label}: sendt ${bytes.length} bytes.`);
}

async function readWithTimeout(endpointNumber, length = 512, timeoutMs = 1500) {
  let timer = null;
  const readPromise = device.transferIn(endpointNumber, length);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Ingen USB IN-data inden for ${timeoutMs} ms.`)), timeoutMs);
  });

  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

connectBtn.addEventListener('click', async () => {
  logEl.textContent = 'Starter WebUSB-diagnose…';

  if (!('usb' in navigator)) {
    log('FEJL: Denne browser understøtter ikke WebUSB. Brug Chrome/Chromium.');
    return;
  }

  try {
    device = await navigator.usb.requestDevice({ filters: [{ vendorId: EPSON_VID }] });

    log(`Valgt enhed: ${device.productName || '(ukendt produktnavn)'}`);
    log(`Producent: ${device.manufacturerName || '(ukendt)'}`);
    log(`VID:PID = ${hex(device.vendorId, 4)}:${hex(device.productId, 4)}`);
    if (device.serialNumber) log(`Serienummer: ${device.serialNumber}`);

    selectedModel = await loadLocalModel(device.productName);

    await device.open();
    log('USB-enheden blev åbnet.');

    if (!device.configuration) {
      if (!device.configurations.length) throw new Error('Printeren har ingen USB-konfigurationer.');
      await device.selectConfiguration(device.configurations[0].configurationValue);
      log(`Valgte USB-konfiguration ${device.configuration.configurationValue}.`);
    } else {
      log(`Aktiv USB-konfiguration: ${device.configuration.configurationValue}.`);
    }

    log('');
    log('Interfaces:');
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        log(`- Interface ${iface.interfaceNumber}, alt ${alt.alternateSetting}, class=${hex(alt.interfaceClass)} subclass=${hex(alt.interfaceSubclass)} protocol=${hex(alt.interfaceProtocol)}`);
        for (const ep of alt.endpoints) log(`    ${describeEndpoint(ep)}`);
      }
    }

    const candidates = getCandidates(device.configuration);
    if (!candidates.length) {
      throw new Error('Fandt ikke et printer- eller vendor-specific interface med både BULK IN og BULK OUT.');
    }

    log('');
    log('Tester hvilke interfaces browseren kan claime. Der sendes stadig INGEN data til printeren.');

    for (const candidate of candidates) {
      log(`Prøver interface ${candidate.interfaceNumber}, class=${hex(candidate.interfaceClass)}, alt=${candidate.alternateSetting}, BULK OUT #${candidate.bulkOut.endpointNumber}, BULK IN #${candidate.bulkIn.endpointNumber}…`);

      try {
        await device.claimInterface(candidate.interfaceNumber);
        claimedInterface = candidate.interfaceNumber;

        if (candidate.alternateSetting !== 0) {
          await device.selectAlternateInterface(candidate.interfaceNumber, candidate.alternateSetting);
        }

        selectedCandidate = candidate;
        log(`SUCCESS: Interface ${candidate.interfaceNumber} blev claimed af browseren.`);
        break;
      } catch (err) {
        log(`  Kunne ikke claime interface ${candidate.interfaceNumber}: ${err?.name || 'Error'}: ${err?.message || err}`);
        try { await device.releaseInterface(candidate.interfaceNumber); } catch (_) {}
        claimedInterface = null;
      }
    }

    if (!selectedCandidate) {
      throw new Error('Ingen af Epson-printerens relevante BULK-interfaces kunne claimes.');
    }

    log('');
    log(`Valgt interface: ${selectedCandidate.interfaceNumber}`);
    log(`Class=${hex(selectedCandidate.interfaceClass)}, alt=${selectedCandidate.alternateSetting}, BULK OUT #${selectedCandidate.bulkOut.endpointNumber}, BULK IN #${selectedCandidate.bulkIn.endpointNumber}`);
    log('Der er stadig IKKE sendt nogen Epson-reset- eller EEPROM-kommandoer.');

    connectBtn.disabled = true;
    testBtn.disabled = false;
    closeBtn.disabled = false;
  } catch (err) {
    log('');
    log(`FEJL: ${err?.name || 'Error'}: ${err?.message || err}`);
    await closeDevice();
  }
});

testBtn.addEventListener('click', async () => {
  if (!device || claimedInterface === null || !selectedCandidate || !selectedModel) {
    log('FEJL: Forbind printeren først.');
    return;
  }

  testBtn.disabled = true;
  log('');
  log('Starter ikke-destruktiv kommunikationstest…');
  log('Der sendes kun EWR-init + D4-init + kanalåbning. Ingen EEPROM-write-pakke indgår.');

  const ejlInit = [
    0x00,0x00,0x00,0x1B,0x01,0x40,0x45,0x4A,0x4C,0x20,0x31,0x32,0x38,0x34,0x2E,0x34,0x0A,
    0x40,0x45,0x4A,0x4C,0x0A,0x40,0x45,0x4A,0x4C,0x0A
  ];
  const d4Init = [0x00,0x00,0x00,0x08,0x01,0x00,0x00,0x10];
  const d4Open = [0x00,0x00,0x00,0x11,0x01,0x00,0x01,0x02,0x02,0x01,0x00,0x01,0x00,0x00,0x00,0x00,0x00];

  try {
    const outEp = selectedCandidate.bulkOut.endpointNumber;
    const inEp = selectedCandidate.bulkIn.endpointNumber;

    await transferOutChecked(outEp, ejlInit, 'EJL init');
    await sleep(40);
    await transferOutChecked(outEp, d4Init, 'D4 init');
    await sleep(40);

    const readPromise = readWithTimeout(inEp, 512, 1500);
    await transferOutChecked(outEp, d4Open, 'D4 open-channel');

    const result = await readPromise;
    if (result.status !== 'ok') {
      throw new Error(`USB IN svarede med status=${result.status}.`);
    }

    const data = result.data
      ? new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength)
      : new Uint8Array();

    if (!data.length) {
      throw new Error('Printeren returnerede et tomt USB-svar.');
    }

    log(`USB IN: modtog ${data.length} bytes.`);
    log(bytesToHex(data));

    const openAck = data.length >= 1 && (data[0] === 0x81 || (data.length >= 7 && data[6] === 0x81));
    if (openAck) {
      log('SUCCESS: Modtog Epson D4 open-channel ACK (0x81). Tovejskommunikation virker.');
    } else {
      log('SUCCESS: Printeren svarede over BULK IN. USB OUT/IN virker.');
    }

    log('Kommunikationstesten er færdig. Ingen EEPROM-værdier er skrevet.');
    testBtn.disabled = false;
  } catch (err) {
    log(`FEJL i kommunikationstest: ${err?.name || 'Error'}: ${err?.message || err}`);
    log('Forbindelsen lukkes for at afbryde eventuelle ventende USB-transfers.');
    await closeDevice();
  }
});

closeBtn.addEventListener('click', closeDevice);

navigator.usb?.addEventListener('disconnect', event => {
  if (device && event.device === device) {
    log('Printeren blev frakoblet USB.');
    device = null;
    claimedInterface = null;
    selectedCandidate = null;
    selectedModel = null;
    connectBtn.disabled = false;
    testBtn.disabled = true;
    closeBtn.disabled = true;
  }
});
