const EPSON_VID = 0x04B8;

const connectBtn = document.querySelector('#connect');
const closeBtn = document.querySelector('#close');
const logEl = document.querySelector('#log');

let device = null;
let claimedInterface = null;

function log(message = '') {
  logEl.textContent += `\n${message}`;
  logEl.scrollTop = logEl.scrollHeight;
}

function hex(n, width = 2) {
  return `0x${Number(n).toString(16).toUpperCase().padStart(width, '0')}`;
}

function describeEndpoint(endpoint) {
  return `${endpoint.direction.toUpperCase()} ${endpoint.type} endpoint #${endpoint.endpointNumber} (${hex(endpoint.endpointNumber)}) packetSize=${endpoint.packetSize}`;
}

function getCandidates(configuration) {
  const candidates = [];
  const seenInterfaces = new Set();

  // Prefer printer-class interfaces first to match EWR's native logic,
  // then try vendor-specific interfaces as a safe diagnostic fallback.
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

  // claimInterface() claims an interface number, not an alternate setting.
  // Keep one representative alternate for each interface during this probe.
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
    connectBtn.disabled = false;
    closeBtn.disabled = true;
    log('Forbindelsen er lukket.');
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
    log('Tester hvilke interfaces browseren kan claim’e. Der sendes stadig INGEN data til printeren.');

    let selected = null;

    for (const candidate of candidates) {
      log(`Prøver interface ${candidate.interfaceNumber}, class=${hex(candidate.interfaceClass)}, alt=${candidate.alternateSetting}, BULK OUT #${candidate.bulkOut.endpointNumber}, BULK IN #${candidate.bulkIn.endpointNumber}…`);

      try {
        await device.claimInterface(candidate.interfaceNumber);
        claimedInterface = candidate.interfaceNumber;

        if (candidate.alternateSetting !== 0) {
          await device.selectAlternateInterface(candidate.interfaceNumber, candidate.alternateSetting);
        }

        selected = candidate;
        log(`SUCCESS: Interface ${candidate.interfaceNumber} kan claimed af browseren.`);
        break;
      } catch (err) {
        log(`  Kunne ikke claime interface ${candidate.interfaceNumber}: ${err?.name || 'Error'}: ${err?.message || err}`);
        try {
          await device.releaseInterface(candidate.interfaceNumber);
        } catch (_) {}
        claimedInterface = null;
      }
    }

    if (!selected) {
      throw new Error('Ingen af Epson-printerens relevante BULK-interfaces kunne claimes. macOS eller en anden driver/applikation ejer dem sandsynligvis.');
    }

    log('');
    log(`Valgt claimbart interface til videre diagnose: ${selected.interfaceNumber}`);
    log(`Class=${hex(selected.interfaceClass)}, alt=${selected.alternateSetting}, BULK OUT #${selected.bulkOut.endpointNumber}, BULK IN #${selected.bulkIn.endpointNumber}`);
    log('Diagnosen er færdig. Der er IKKE sendt nogen Epson-reset- eller EEPROM-kommandoer.');

    connectBtn.disabled = true;
    closeBtn.disabled = false;
  } catch (err) {
    log('');
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
    connectBtn.disabled = false;
    closeBtn.disabled = true;
  }
});
