const EPSON_VID = 0x04B8;

const connectBtn = document.querySelector('#connect');
const resetBtn = document.querySelector('#reset');
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
  const key = Object.keys(models).find(k => k.toLowerCase() === wanted.toLowerCase());

  if (!key) {
    throw new Error(`Printermodellen '${wanted}' blev ikke fundet i den lokale database.`);
  }

  const model = models[key];
  const groups = Array.isArray(model.pad_groups) ? model.pad_groups : [];
  const writes = groups.reduce(
    (sum, group) => sum + (Array.isArray(group.addresses) ? group.addresses.length : 0),
    0
  );

  if (!groups.length || !writes) {
    throw new Error(`Printermodellen '${key}' har ingen resetdata i databasen.`);
  }

  log(`Model fundet i databasen: ${key}`);
  log(`Reset omfatter ${groups.length} pad-gruppe(r) og ${writes} EEPROM-skrivning(er).`);
  for (const group of groups) {
    const count = Array.isArray(group.addresses) ? group.addresses.length : 0;
    log(`- ${group.desc || group.kind || 'Pad group'}: ${count} skrivning(er)`);
  }

  return { name: key, data: model };
}

function generateWritePacket(rkey, address, value, wkey) {
  const CMD_EEPROM_WRITE = 0x42;
  const PREFIX_PIPE = 0x7C;
  const SOCKET_EPSON_CTRL = 0x02;
  const CREDIT = 0x00;

  const c = CMD_EEPROM_WRITE;
  const notC = (~c) & 0xFF;
  const shiftC = ((c >> 1) & 0x7F) | ((c << 7) & 0x80);

  const inner = [
    rkey & 0xFF,
    (rkey >> 8) & 0xFF,
    c,
    notC,
    shiftC,
    address & 0xFF,
    (address >> 8) & 0xFF,
    value & 0xFF,
    ...Array.from(String(wkey), ch => ch.charCodeAt(0) & 0xFF),
  ];

  const epsonCmd = [
    PREFIX_PIPE,
    PREFIX_PIPE,
    inner.length & 0xFF,
    (inner.length >> 8) & 0xFF,
    ...inner,
  ];

  const d4Len = epsonCmd.length + 6;
  return [
    SOCKET_EPSON_CTRL,
    SOCKET_EPSON_CTRL,
    (d4Len >> 8) & 0xFF,
    d4Len & 0xFF,
    CREDIT,
    0x00,
    ...epsonCmd,
  ];
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
  const hadDevice = Boolean(device);

  try {
    if (device && claimedInterface !== null) {
      try { await device.releaseInterface(claimedInterface); } catch (_) {}
    }
    if (device?.opened) {
      try { await device.close(); } catch (_) {}
    }
  } finally {
    device = null;
    claimedInterface = null;
    selectedCandidate = null;
    selectedModel = null;

    connectBtn.disabled = false;
    resetBtn.disabled = true;
    closeBtn.disabled = true;

    if (hadDevice) log('Forbindelsen er lukket.');
  }
}

async function transferOutChecked(endpointNumber, bytes, label) {
  const result = await device.transferOut(endpointNumber, Uint8Array.from(bytes));
  if (result.status !== 'ok' || result.bytesWritten !== bytes.length) {
    throw new Error(
      `${label}: USB OUT fejlede (status=${result.status}, skrevet=${result.bytesWritten}/${bytes.length}).`
    );
  }
  log(`${label}: sendt ${bytes.length} bytes.`);
}

connectBtn.addEventListener('click', async () => {
  logEl.textContent = 'Søger efter Epson-printer…';
  resetBtn.disabled = true;
  closeBtn.disabled = true;

  if (!('usb' in navigator)) {
    log('FEJL: Denne browser understøtter ikke WebUSB. Brug Chrome eller Chromium.');
    return;
  }

  try {
    device = await navigator.usb.requestDevice({ filters: [{ vendorId: EPSON_VID }] });

    log(`Printer: ${device.productName || '(ukendt model)'}`);
    log(`VID:PID ${hex(device.vendorId, 4)}:${hex(device.productId, 4)}`);
    if (device.serialNumber) log(`Serienummer: ${device.serialNumber}`);

    selectedModel = await loadLocalModel(device.productName);

    await device.open();
    if (!device.configuration) {
      if (!device.configurations.length) {
        throw new Error('Printeren har ingen USB-konfigurationer.');
      }
      await device.selectConfiguration(device.configurations[0].configurationValue);
    }

    const candidates = getCandidates(device.configuration);
    if (!candidates.length) {
      throw new Error('Fandt ikke et egnet BULK IN/OUT-interface på printeren.');
    }

    for (const candidate of candidates) {
      try {
        await device.claimInterface(candidate.interfaceNumber);
        claimedInterface = candidate.interfaceNumber;

        if (candidate.alternateSetting !== 0) {
          await device.selectAlternateInterface(candidate.interfaceNumber, candidate.alternateSetting);
        }

        selectedCandidate = candidate;
        break;
      } catch (_) {
        try { await device.releaseInterface(candidate.interfaceNumber); } catch (_) {}
        claimedInterface = null;
      }
    }

    if (!selectedCandidate) {
      throw new Error('Printerens USB-interface kunne ikke overtages af browseren.');
    }

    log(
      `USB klar: interface ${selectedCandidate.interfaceNumber}, ` +
      `OUT #${selectedCandidate.bulkOut.endpointNumber}, IN #${selectedCandidate.bulkIn.endpointNumber}.`
    );
    log('Printeren er klar til reset.');

    connectBtn.disabled = true;
    resetBtn.disabled = false;
    closeBtn.disabled = false;
  } catch (err) {
    log(`FEJL: ${err?.name || 'Error'}: ${err?.message || err}`);
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
    resetBtn.disabled = true;
    closeBtn.disabled = true;
  }
});
