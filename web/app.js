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

function findBestInterface(configuration) {
  const candidates = [];

  for (const iface of configuration.interfaces) {
    for (const alt of iface.alternates) {
      const bulkIn = alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'in');
      const bulkOut = alt.endpoints.find(e => e.type === 'bulk' && e.direction === 'out');
      if (!bulkIn || !bulkOut) continue;

      const isPrinterClass = alt.interfaceClass === 0x07;
      const isVendorSpecific = alt.interfaceClass === 0xFF;
      if (!isPrinterClass && !isVendorSpecific) continue;

      candidates.push({
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

  candidates.sort((a, b) => a.priority - b.priority || a.interfaceNumber - b.interfaceNumber);
  return candidates[0] ?? null;
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

    const selected = findBestInterface(device.configuration);
    if (!selected) {
      throw new Error('Fandt ikke et printer- eller vendor-specific interface med både BULK IN og BULK OUT.');
    }

    log('');
    log(`Bedste kandidat: interface ${selected.interfaceNumber}, class=${hex(selected.interfaceClass)}, BULK OUT #${selected.bulkOut.endpointNumber}, BULK IN #${selected.bulkIn.endpointNumber}`);

    if (selected.alternateSetting !== 0) {
      await device.selectAlternateInterface(selected.interfaceNumber, selected.alternateSetting);
      log(`Valgte alternate setting ${selected.alternateSetting}.`);
    }

    await device.claimInterface(selected.interfaceNumber);
    claimedInterface = selected.interfaceNumber;
    log(`SUCCESS: Interface ${selected.interfaceNumber} blev claimed af browseren.`);
    log('');
    log('Diagnosen er færdig. Der er IKKE sendt nogen Epson-reset- eller EEPROM-kommandoer.');

    connectBtn.disabled = true;
    closeBtn.disabled = false;
  } catch (err) {
    log('');
    log(`FEJL: ${err?.name || 'Error'}: ${err?.message || err}`);
    log('Hvis fejlen opstår ved claimInterface(), er interfacet sandsynligvis optaget af macOS/driveren.');
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
