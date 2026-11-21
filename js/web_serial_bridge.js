// Browser Web Serial, WebUSB (CDC-ACM, FTDI, CP210x, CH34x, PL2303), and WakeLock bridge for Rust/WASM.

const WEBUSB_FILTERS = [
  { vendorId: 0x0403 }, // FTDI
  { vendorId: 0x10c4 }, // Silicon Labs CP210x
  { vendorId: 0x1a86 }, // QinHeng CH340/CH341/CH9102
  { vendorId: 0x067b }, // Prolific PL2303
  { vendorId: 0x303a }, // Espressif
  { vendorId: 0x2e8a }, // Raspberry Pi Pico
  { vendorId: 0x0483 }, // STMicroelectronics
  { vendorId: 0x1915 }, // Nordic
  { vendorId: 0x2341 }, // Arduino
  { vendorId: 0x1d50 }, // OpenMoko / Black Magic Probe
  { vendorId: 0x239a }, // Adafruit
  { vendorId: 0x1b4f }, // SparkFun
  { vendorId: 0x2886 }, // Seeed Studio
  { classCode: 2, subclassCode: 2 },
  { classCode: 239, subclassCode: 2, protocolCode: 1 },
];

const NATIVE_CDC_VIDS = new Set([0x303a, 0x2e8a, 0x1915, 0x2341, 0x1d50, 0x239a, 0x2886]);

function formatVidPid(vid, pid) {
  if (!vid && !pid) return '';
  return `${(vid ?? 0).toString(16).toUpperCase().padStart(4, '0')}:${(pid ?? 0)
    .toString(16)
    .toUpperCase()
    .padStart(4, '0')}`;
}

function detectDriverKind(vid) {
  switch (vid) {
    case 0x0403: return 'FTDI';
    case 0x10c4: return 'CP210X';
    case 0x1a86: return 'CH34X';
    case 0x067b: return 'PL2303';
    default: return 'CDC_ACM';
  }
}

function identifyChip(vid) {
  if (!vid) return 'Web Serial';
  switch (vid) {
    case 0x0403: return 'FTDI';
    case 0x10c4: return 'CP210x';
    case 0x1a86: return 'CH34x';
    case 0x067b: return 'PL2303';
    case 0x303a: return 'Espressif CDC';
    case 0x2e8a: return 'RP2040 CDC';
    case 0x0483: return 'STM32 VCP';
    case 0x1915: return 'Nordic CDC';
    case 0x2341: return 'Arduino CDC';
    case 0x2886: return 'Seeed XIAO';
    default: return 'CDC-ACM';
  }
}

function defaultLines(vid, driverKind) {
  const isNative = NATIVE_CDC_VIDS.has(vid) || (vid === 0x0483 && (!driverKind || driverKind === 'CDC_ACM'));
  return { dtr: isNative, rts: false };
}

function encodeCdcLineCoding(cfg) {
  const buf = new ArrayBuffer(7);
  const v = new DataView(buf);
  v.setUint32(0, cfg.baudRate, true);
  v.setUint8(4, cfg.stopBits === 2 ? 2 : 0);
  v.setUint8(5, cfg.parity);
  v.setUint8(6, cfg.dataBits);
  return new Uint8Array(buf);
}

function encodeFtdiBaud(baud) {
  if (baud >= 3000000) return { value: 0, index: 0 };
  if (baud === 2000000) return { value: 1, index: 0 };
  const sub = [0, 3, 2, 4, 1, 5, 6, 7];
  const div = Math.max(2, Math.round((48000000 / 16) / baud * 8));
  let enc = (div >> 3) | (sub[div & 7] << 14);
  if (enc === 1) enc = 0;
  else if (enc === 0x4001) enc = 1;
  return { value: enc & 0xffff, index: (enc >> 16) & 0xffff };
}

function encodeCh34xBaud(baud) {
  const clk = 12000000;
  const bClamp = Math.max(50, Math.min(3000000, baud));
  let a = 0;
  let b = 0;
  if (bClamp >= 1500000) {
    a = 3;
    b = 256 - Math.round(clk / bClamp);
  } else if (bClamp >= 24000) {
    a = 3;
    b = 256 - Math.round((clk / 2) / bClamp);
    if (b < 2 || b > 255) {
      a = 2;
      b = 256 - Math.round((clk / 16) / bClamp);
    }
  } else if (bClamp >= 3000) {
    a = 2;
    b = 256 - Math.round((clk / 16) / bClamp);
  } else if (bClamp >= 400) {
    a = 1;
    b = 256 - Math.round((clk / 128) / bClamp);
  } else {
    a = 0;
    b = 256 - Math.round((clk / 1024) / bClamp);
  }
  const cb = Math.max(0, Math.min(255, b));
  return { factor: (cb << 8) | 0x80 | a };
}

function decodeFtdiPayload(raw, packetSize = 64) {
  const eff = Math.max(3, packetSize);
  if (raw.byteLength <= 2) return new Uint8Array(0);
  if (raw.byteLength <= eff) return raw.subarray(2);
  const chunks = [];
  let total = 0;
  for (let off = 0; off < raw.byteLength; off += eff) {
    const end = Math.min(raw.byteLength, off + eff);
    if (end - off > 2) {
      const s = raw.subarray(off + 2, end);
      chunks.push(s);
      total += s.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

function enumerateWebUsbPorts(device) {
  const config = device.configuration ?? device.configurations?.[0];
  if (!config) return [];
  const vendorKind = detectDriverKind(device.vendorId);
  const ifaces = config.interfaces;
  const ports = [];
  const isKnownBridge = device.vendorId in { 0x0403: 1, 0x10c4: 1, 0x1a86: 1, 0x067b: 1 };

  for (let i = 0; i < ifaces.length; i++) {
    const iface = ifaces[i];
    const alt = iface.alternate;
    let inEp = null;
    let outEp = null;
    for (const ep of alt.endpoints) {
      if (ep.type !== 'bulk') continue;
      if (ep.direction === 'in' && !inEp) inEp = ep;
      if (ep.direction === 'out' && !outEp) outEp = ep;
    }
    if (!inEp || !outEp) continue;

    let ctrlIface = iface.interfaceNumber;
    let kind = vendorKind;
    if (alt.interfaceClass === 10) {
      kind = 'CDC_ACM';
      for (let j = i - 1; j >= 0; j--) {
        if (ifaces[j].alternate.interfaceClass === 2) {
          ctrlIface = ifaces[j].interfaceNumber;
          break;
        }
      }
    } else if (alt.interfaceClass === 2 && alt.interfaceSubclass === 2) {
      kind = 'CDC_ACM';
    }

    const isCdc = alt.interfaceClass === 10 || alt.interfaceClass === 2;
    if (!isKnownBridge && !isCdc && alt.interfaceClass === 0xff && ports.length > 0) continue;

    ports.push({
      portIndex: ports.length,
      driverKind: kind,
      controlInterfaceNumber: ctrlIface,
      dataInterfaceNumber: iface.interfaceNumber,
      inEndpointNumber: inEp.endpointNumber,
      outEndpointNumber: outEp.endpointNumber,
      inPacketSize: inEp.packetSize || 64,
    });
  }
  return ports;
}

class WebUsbDriverSession {
  constructor(device, port) {
    this.device = device;
    this.port = port;
  }

  async init(cfg, dtr, rts) {
    if (this.port.driverKind === 'FTDI') {
      await this.device.controlTransferOut({
        requestType: 'vendor', recipient: 'device', request: 0x00, value: 0x00,
        index: this.port.dataInterfaceNumber + 1,
      });
    } else if (this.port.driverKind === 'CP210X') {
      await this.device.controlTransferOut({
        requestType: 'vendor', recipient: 'interface', request: 0x00, value: 0x0001,
        index: this.port.dataInterfaceNumber,
      });
    } else if (this.port.driverKind === 'CH34X') {
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0xa1, value: 0, index: 0 });
      await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x9a, value: 0x0f2c, index: 0x0007 });
    }
    await this.setParameters(cfg);
    await this.setControlLines(dtr, rts);
  }

  async setParameters(cfg) {
    switch (this.port.driverKind) {
      case 'CDC_ACM':
        await this.device.controlTransferOut(
          { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: this.port.controlInterfaceNumber },
          encodeCdcLineCoding(cfg),
        );
        break;
      case 'FTDI': {
        const chIdx = this.port.dataInterfaceNumber + 1;
        const { value, index } = encodeFtdiBaud(cfg.baudRate);
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x03, value, index: (index << 8) | chIdx });
        const fPar = cfg.parity === 1 ? 0x0100 : cfg.parity === 2 ? 0x0200 : 0x0000;
        const fStop = cfg.stopBits === 2 ? 0x1000 : 0x0000;
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x04, value: (cfg.dataBits & 0xff) | fPar | fStop, index: chIdx });
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x02, value: cfg.flowControl === 1 ? 0x0100 : 0x0000, index: chIdx });
        break;
      }
      case 'CP210X': {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setUint32(0, cfg.baudRate, true);
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: 0x1e, value: 0, index: this.port.dataInterfaceNumber }, buf);
        const cPar = cfg.parity === 1 ? 0x0010 : cfg.parity === 2 ? 0x0020 : 0x0000;
        const cStop = cfg.stopBits === 2 ? 0x0002 : 0x0000;
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: 0x03, value: ((cfg.dataBits & 0x0f) << 8) | cPar | cStop, index: this.port.dataInterfaceNumber });
        break;
      }
      case 'CH34X': {
        const { factor } = encodeCh34xBaud(cfg.baudRate);
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x9a, value: 0x1312, index: factor });
        let lcr = 0xc0 | (cfg.dataBits === 7 ? 0x02 : 0x03);
        if (cfg.stopBits === 2) lcr |= 0x04;
        if (cfg.parity === 1) lcr |= 0x08;
        if (cfg.parity === 2) lcr |= 0x18;
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x9a, value: 0x2518, index: lcr });
        break;
      }
      case 'PL2303':
        await this.device.controlTransferOut(
          { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: 0 },
          encodeCdcLineCoding(cfg),
        );
        break;
    }
  }

  async setControlLines(dtr, rts) {
    switch (this.port.driverKind) {
      case 'CDC_ACM':
      case 'PL2303':
        await this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: (dtr ? 1 : 0) | (rts ? 2 : 0), index: this.port.controlInterfaceNumber });
        break;
      case 'FTDI':
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0x01, value: (dtr ? 0x0101 : 0x0100) | (rts ? 0x0202 : 0x0200), index: this.port.dataInterfaceNumber + 1 });
        break;
      case 'CP210X':
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'interface', request: 0x07, value: 0x0300 | (dtr ? 1 : 0) | (rts ? 2 : 0), index: this.port.dataInterfaceNumber });
        break;
      case 'CH34X':
        await this.device.controlTransferOut({ requestType: 'vendor', recipient: 'device', request: 0xa4, value: (~((dtr ? 0x20 : 0) | (rts ? 0x40 : 0))) & 0xff, index: 0 });
        break;
    }
  }

  decodeIncoming(raw) {
    return this.port.driverKind === 'FTDI' ? decodeFtdiPayload(raw, this.port.inPacketSize) : raw;
  }
}

const LAST_DEV_KEY = 'hotwire_serial_last_device';

const state = {
  webSerialPort: null,
  webSerialReader: null,
  webSerialWriter: null,
  webUsbDevice: null,
  webUsbPorts: [],
  webUsbPortIdx: 0,
  webUsbSession: null,
  webUsbReadActive: false,
  wakeLock: null,
  epoch: 0,
  cfg: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 0, flowControl: 0 },
  dtr: true,
  rts: false,
  transport: 'none',
  autoConnectEnabled: true,
  manualDisconnect: false,
  flashing: false,
  reconnecting: false,
  reconnectTimer: null,
  listenersRegistered: false,
  onState: null,
  onBytes: null,
};

function saveLastDevice(backend, vid, pid, serialNumber = '') {
  try {
    localStorage.setItem(
      LAST_DEV_KEY,
      JSON.stringify({ backend, vid: vid ?? 0, pid: pid ?? 0, serialNumber: serialNumber ?? '' }),
    );
  } catch {}
}

function loadLastDevice() {
  try {
    const raw = localStorage.getItem(LAST_DEV_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function matchesLastSerialPort(port, last) {
  if (!last || last.backend !== 'webserial') return false;
  const info = port.getInfo?.() ?? {};
  const vid = info.usbVendorId ?? 0;
  const pid = info.usbProductId ?? 0;
  if (last.vid === 0 && last.pid === 0) return true;
  return vid === last.vid && pid === last.pid;
}

function matchesLastUsbDevice(device, last) {
  if (!last || last.backend !== 'webusb') return false;
  if ((device.vendorId ?? 0) !== last.vid || (device.productId ?? 0) !== last.pid) return false;
  if (last.serialNumber && device.serialNumber && device.serialNumber !== last.serialNumber) {
    return false;
  }
  return true;
}

function scheduleAutoReconnect(candidate = null, delayMs = 350, attempt = 0) {
  if (!state.autoConnectEnabled || state.manualDisconnect || state.flashing) return;
  if (state.webSerialPort || state.webUsbDevice || state.reconnecting) return;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    if (!state.autoConnectEnabled || state.manualDisconnect || state.flashing) return;
    if (state.webSerialPort || state.webUsbDevice || state.reconnecting) return;

    const last = loadLastDevice();
    const backend = last?.backend || preferredBackend();
    state.reconnecting = true;
    try {
      if (backend === 'webusb' && navigator.usb) {
        const devices = await navigator.usb.getDevices();
        let target = candidate && typeof candidate.open === 'function' && (!last || matchesLastUsbDevice(candidate, last))
          ? candidate
          : devices.find((d) => matchesLastUsbDevice(d, last));
        if (!target && !last && devices.length === 1) target = devices[0];
        if (target) {
          await openWebUsb(target, state.cfg, 0);
          return;
        }
      } else if (navigator.serial) {
        const ports = await navigator.serial.getPorts();
        let target = candidate && typeof candidate.open === 'function' && (!last || matchesLastSerialPort(candidate, last))
          ? candidate
          : ports.find((p) => matchesLastSerialPort(p, last));
        if (!target && !last && ports.length === 1) target = ports[0];
        if (target) {
          await openWebSerial(target, state.cfg);
          return;
        }
      }
    } catch {
      if (attempt < 3 && state.autoConnectEnabled && !state.manualDisconnect && !state.flashing) {
        state.reconnecting = false;
        scheduleAutoReconnect(candidate, 500, attempt + 1);
        return;
      }
    } finally {
      state.reconnecting = false;
    }
  }, delayMs);
}

function notifyState(status, transport, deviceName, vidPid, portIdx, portCount, dtr, rts, errorMessage) {
  state.transport = transport;
  if (state.onState) {
    state.onState(
      JSON.stringify({
        status,
        transport,
        device_name: deviceName ?? '',
        vid_pid: vidPid ?? '',
        port_index: portIdx ?? 0,
        port_count: portCount ?? 0,
        dtr: Boolean(dtr),
        rts: Boolean(rts),
        error_message: errorMessage ?? '',
      }),
    );
  }
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {}
}

async function releaseWakeLock() {
  try {
    if (state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch {}
}

function preferredBackend() {
  const ua = navigator.userAgent ?? '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const hasSerial = 'serial' in navigator && Boolean(navigator.serial);
  const hasUsb = 'usb' in navigator && Boolean(navigator.usb);
  if (isMobile && hasUsb) return 'webusb';
  if (hasSerial) return 'webserial';
  if (hasUsb) return 'webusb';
  return 'none';
}

async function closeAll() {
  state.webUsbReadActive = false;
  if (state.webSerialReader) {
    try { await state.webSerialReader.cancel(); } catch {}
    try { state.webSerialReader.releaseLock(); } catch {}
    state.webSerialReader = null;
  }
  if (state.webSerialWriter) {
    try { state.webSerialWriter.releaseLock(); } catch {}
    state.webSerialWriter = null;
  }
  if (state.webSerialPort) {
    try { await state.webSerialPort.close(); } catch {}
    state.webSerialPort = null;
  }
  if (state.webUsbDevice) {
    try {
      for (const p of state.webUsbPorts) {
        try { await state.webUsbDevice.releaseInterface(p.dataInterfaceNumber); } catch {}
        if (p.controlInterfaceNumber !== p.dataInterfaceNumber) {
          try { await state.webUsbDevice.releaseInterface(p.controlInterfaceNumber); } catch {}
        }
      }
      await state.webUsbDevice.close();
    } catch {}
    state.webUsbDevice = null;
  }
  state.webUsbSession = null;
  state.webUsbPorts = [];
  await releaseWakeLock();
}

async function openWebSerial(port, cfg) {
  state.epoch += 1;
  const epoch = state.epoch;
  await closeAll();
  state.cfg = { ...cfg };

  const info = port.getInfo?.() ?? {};
  const vid = info.usbVendorId ?? 0;
  const pid = info.usbProductId ?? 0;
  const lines = defaultLines(vid, null);
  state.dtr = lines.dtr;
  state.rts = lines.rts;

  notifyState('connecting', 'webserial', identifyChip(vid), formatVidPid(vid, pid), 0, 1, state.dtr, state.rts, '');

  const parityStr = cfg.parity === 1 ? 'odd' : cfg.parity === 2 ? 'even' : 'none';
  await port.open({
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: parityStr,
    flowControl: cfg.flowControl === 1 ? 'hardware' : 'none',
    bufferSize: 16384,
  });

  state.webSerialPort = port;
  state.webSerialWriter = port.writable.getWriter();
  state.manualDisconnect = false;
  saveLastDevice('webserial', vid, pid, '');
  try { await port.setSignals({ dataTerminalReady: state.dtr, requestToSend: state.rts }); } catch {}
  await acquireWakeLock();
  notifyState('connected', 'webserial', identifyChip(vid), formatVidPid(vid, pid), 0, 1, state.dtr, state.rts, '');

  (async () => {
    try {
      while (state.epoch === epoch && port.readable) {
        const reader = port.readable.getReader();
        state.webSerialReader = reader;
        try {
          while (state.epoch === epoch) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0 && state.onBytes) state.onBytes(value);
          }
        } finally {
          try { reader.releaseLock(); } catch {}
          state.webSerialReader = null;
        }
      }
    } catch (err) {
      if (state.epoch === epoch) {
        await closeAll();
        notifyState('waiting', 'none', '', '', 0, 0, false, false, err?.message ?? 'Serial disconnected');
      }
      return;
    }
    if (state.epoch === epoch) {
      await closeAll();
      notifyState('waiting', 'none', '', '', 0, 0, false, false, '');
    }
  })();
}

async function openWebUsb(device, cfg, portIdx = 0) {
  state.epoch += 1;
  const epoch = state.epoch;
  await closeAll();
  state.cfg = { ...cfg };

  const vid = device.vendorId ?? 0;
  const pid = device.productId ?? 0;
  const name = device.productName || identifyChip(vid);
  const vp = formatVidPid(vid, pid);

  notifyState('connecting', 'webusb', name, vp, portIdx, 1, false, false, '');

  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const ports = enumerateWebUsbPorts(device);
  if (ports.length === 0) throw new Error('No supported USB serial endpoints found.');

  const idx = Math.max(0, Math.min(portIdx, ports.length - 1));
  const desc = ports[idx];
  await device.claimInterface(desc.dataInterfaceNumber);
  if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
    try { await device.claimInterface(desc.controlInterfaceNumber); } catch {}
  }

  const lines = defaultLines(vid, desc.driverKind);
  state.dtr = lines.dtr;
  state.rts = lines.rts;
  state.webUsbDevice = device;
  state.webUsbPorts = ports;
  state.webUsbPortIdx = idx;

  const session = new WebUsbDriverSession(device, desc);
  state.webUsbSession = session;
  state.manualDisconnect = false;
  saveLastDevice('webusb', vid, pid, device.serialNumber ?? '');
  await session.init(cfg, state.dtr, state.rts);
  await acquireWakeLock();
  notifyState('connected', 'webusb', name, vp, idx, ports.length, state.dtr, state.rts, '');

  state.webUsbReadActive = true;
  (async () => {
    const readSize = Math.max(64, desc.inPacketSize);
    try {
      while (state.epoch === epoch && state.webUsbReadActive && device.opened) {
        const res = await device.transferIn(desc.inEndpointNumber, readSize);
        if (!state.webUsbReadActive || state.epoch !== epoch) break;
        if (res.status === 'stall') {
          await device.clearHalt?.('in', desc.inEndpointNumber);
          continue;
        }
        if (res.status === 'ok' && res.data && res.data.byteLength > 0) {
          const raw = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
          const decoded = session.decodeIncoming(raw);
          if (decoded.byteLength > 0 && state.onBytes) state.onBytes(decoded);
        }
      }
    } catch (err) {
      if (state.epoch === epoch) {
        await closeAll();
        notifyState('waiting', 'none', '', '', 0, 0, false, false, err?.message ?? 'WebUSB disconnected');
      }
      return;
    }
    if (state.epoch === epoch) {
      await closeAll();
      notifyState('waiting', 'none', '', '', 0, 0, false, false, '');
    }
  })();
}

export function js_init_serial(onState, onBytes) {
  state.onState = onState;
  state.onBytes = onBytes;
  if (state.listenersRegistered) return;
  state.listenersRegistered = true;

  if ('serial' in navigator && navigator.serial) {
    navigator.serial.addEventListener('connect', (ev) => {
      scheduleAutoReconnect(ev?.port ?? null, 350);
    });
    navigator.serial.addEventListener('disconnect', () => {
      if (state.transport === 'webserial') {
        state.epoch += 1;
        closeAll().then(() => notifyState('waiting', 'none', '', '', 0, 0, false, false, ''));
      }
    });
  }
  if ('usb' in navigator && navigator.usb) {
    navigator.usb.addEventListener('connect', (ev) => {
      scheduleAutoReconnect(ev?.device ?? null, 350);
    });
    navigator.usb.addEventListener('disconnect', (ev) => {
      if (state.transport === 'webusb' && ev.device === state.webUsbDevice) {
        state.epoch += 1;
        closeAll().then(() => notifyState('waiting', 'none', '', '', 0, 0, false, false, ''));
      }
    });
  }
}

export function js_set_auto_connect(enabled, baudRate, dataBits, stopBits, parity, flowControl) {
  state.autoConnectEnabled = Boolean(enabled);
  state.cfg = { baudRate, dataBits, stopBits, parity, flowControl };
  if (state.autoConnectEnabled && !state.manualDisconnect && !state.flashing && !state.webSerialPort && !state.webUsbDevice) {
    if (loadLastDevice()) {
      scheduleAutoReconnect(null, 80);
    }
  } else if (!state.autoConnectEnabled && state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

export async function js_connect_serial(baudRate, dataBits, stopBits, parity, flowControl) {
  state.manualDisconnect = false;
  const cfg = { baudRate, dataBits, stopBits, parity, flowControl };
  const backend = preferredBackend();
  if (backend === 'webusb' && navigator.usb) {
    const dev = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
    await openWebUsb(dev, cfg, 0);
  } else if (navigator.serial) {
    const port = await navigator.serial.requestPort();
    await openWebSerial(port, cfg);
  } else {
    throw new Error('Web Serial or WebUSB API is not supported in this browser.');
  }
}

export async function js_disconnect_serial() {
  state.manualDisconnect = true;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.epoch += 1;
  await closeAll();
  notifyState('waiting', 'none', '', '', 0, 0, false, false, '');
}

export async function js_write_serial(bytes) {
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (state.transport === 'webserial' && state.webSerialWriter) {
    await state.webSerialWriter.write(payload);
  } else if (state.transport === 'webusb' && state.webUsbDevice && state.webUsbSession) {
    const ep = state.webUsbPorts[state.webUsbPortIdx]?.outEndpointNumber;
    if (ep != null) {
      await state.webUsbDevice.transferOut(ep, payload);
    }
  }
}

export async function js_set_signals(dtr, rts) {
  state.dtr = dtr;
  state.rts = rts;
  if (state.transport === 'webserial' && state.webSerialPort) {
    await state.webSerialPort.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
  } else if (state.transport === 'webusb' && state.webUsbSession) {
    await state.webUsbSession.setControlLines(dtr, rts);
  }
}

export async function js_pulse_reset() {
  if (state.transport === 'none') return;
  const prevDtr = state.dtr;
  const prevRts = state.rts;
  await js_set_signals(false, true);
  await new Promise((r) => setTimeout(r, 100));
  await js_set_signals(prevDtr, prevRts);
}

export async function js_reconfigure_serial(baudRate, dataBits, stopBits, parity, flowControl) {
  const cfg = { baudRate, dataBits, stopBits, parity, flowControl };
  state.cfg = { ...cfg };
  if (state.transport === 'webserial' && state.webSerialPort) {
    const port = state.webSerialPort;
    await openWebSerial(port, cfg);
  } else if (state.transport === 'webusb' && state.webUsbSession) {
    await state.webUsbSession.setParameters(cfg);
  }
}

export async function js_switch_usb_port(portIdx) {
  if (state.transport === 'webusb' && state.webUsbDevice) {
    const dev = state.webUsbDevice;
    await openWebUsb(dev, state.cfg, portIdx);
  }
}

export async function js_flash_firmware(
  boardId,
  forceOtherPort,
  flashOffset,
  customFile,
  bootloaderCmd,
  onLog,
  onProgress,
) {
  state.flashing = true;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  try {
    return await flashFirmwareInternal(
      boardId,
      forceOtherPort,
      flashOffset,
      customFile,
      bootloaderCmd,
      onLog,
      onProgress,
    );
  } finally {
    state.flashing = false;
  }
}

async function flashFirmwareInternal(
  boardId,
  forceOtherPort,
  flashOffset,
  customFile,
  bootloaderCmd,
  onLog,
  onProgress,
) {
  if (typeof navigator === 'undefined' || (!navigator.serial && !navigator.usb)) {
    throw new Error('Web Serial or WebUSB API is required for browser firmware flashing.');
  }

  const profiles = {
    esp32s3: {
      label: 'Seeed Studio XIAO ESP32-S3',
      prefix: 'HotWire_UART_XIAO_ESP32S3.ino',
      bootloaderOffset: 0x0,
      flashSize: '8MB',
    },
    esp32c6: {
      label: 'Seeed Studio XIAO ESP32-C6',
      prefix: 'HotWire_UART_XIAO_ESP32C6.ino',
      bootloaderOffset: 0x0,
      flashSize: '4MB',
    },
  };
  const profile = profiles[boardId] ?? profiles.esp32s3;

  const backend = preferredBackend();
  const useWebUsb =
    state.transport === 'webusb' ||
    (state.transport !== 'webserial' && backend === 'webusb');

  let port = null;
  let webUsbDevice = null;

  onLog(`[1/4] Preparing to flash ${profile.label}...`);
  if (useWebUsb && navigator.usb) {
    const activeUsb = forceOtherPort ? null : state.webUsbDevice;
    if (!forceOtherPort && state.transport === 'webusb' && activeUsb) {
      onLog('Entering ROM bootloader & closing WebUSB transport...');
      try { await js_write_serial(bootloaderCmd); } catch {}
      await new Promise((r) => setTimeout(r, 250));
      state.epoch += 1;
      await closeAll();
      webUsbDevice = activeUsb;
    } else {
      onLog('Select the XIAO ESP32 USB-JTAG / CDC device in the browser WebUSB prompt...');
      webUsbDevice = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
    }
    // Lightweight WebUSB wrapper for flashing
    const cfg = webUsbDevice.configuration ?? webUsbDevice.configurations?.[0];
    const ports = enumerateWebUsbPorts(webUsbDevice);
    const desc = ports[0];
    if (!desc) throw new Error('No CDC bulk endpoints found on USB device.');
    port = {
      readable: null,
      writable: null,
      open: async () => {
        if (!webUsbDevice.opened) await webUsbDevice.open();
        if (!webUsbDevice.configuration && cfg) await webUsbDevice.selectConfiguration(cfg.configurationValue);
        await webUsbDevice.claimInterface(desc.dataInterfaceNumber);
        if (desc.controlInterfaceNumber !== desc.dataInterfaceNumber) {
          try { await webUsbDevice.claimInterface(desc.controlInterfaceNumber); } catch {}
        }
        let running = true;
        port.readable = new ReadableStream({
          pull: async (ctrl) => {
            while (running && webUsbDevice.opened) {
              const r = await webUsbDevice.transferIn(desc.inEndpointNumber, Math.max(64, desc.inPacketSize));
              if (r.status === 'ok' && r.data?.byteLength > 0) {
                ctrl.enqueue(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
                return;
              }
            }
            try { ctrl.close(); } catch {}
          },
          cancel: () => { running = false; },
        });
        port.writable = new WritableStream({
          write: async (chunk) => {
            await webUsbDevice.transferOut(desc.outEndpointNumber, chunk);
          },
        });
      },
      close: async () => {
        try { await webUsbDevice.releaseInterface(desc.dataInterfaceNumber); } catch {}
        try { await webUsbDevice.close(); } catch {}
      },
      setSignals: async (sig) => {
        await webUsbDevice.controlTransferOut({
          requestType: 'class', recipient: 'interface', request: 0x22,
          value: (sig.dataTerminalReady ? 1 : 0) | (sig.requestToSend ? 2 : 0),
          index: desc.controlInterfaceNumber,
        });
      },
      getInfo: () => ({ usbVendorId: webUsbDevice.vendorId, usbProductId: webUsbDevice.productId }),
    };
  } else if (navigator.serial) {
    let serialPort = forceOtherPort ? null : state.webSerialPort;
    if (!forceOtherPort && state.transport === 'webserial' && serialPort) {
      onLog('Sending bootloader entry command & closing serial transport...');
      try { await js_write_serial(bootloaderCmd); } catch {}
      await new Promise((r) => setTimeout(r, 250));
      state.epoch += 1;
      await closeAll();
    } else {
      onLog('Select the XIAO ESP32 USB-JTAG / CDC COM port in the browser prompt...');
      serialPort = await navigator.serial.requestPort();
    }
    port = serialPort;
  }

  if (!port) throw new Error('No serial or USB port selected.');

  const fileArray = [];
  if (customFile) {
    onLog(`Reading selected file: ${customFile.name}...`);
    const buf = new Uint8Array(await customFile.arrayBuffer());
    const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
    fileArray.push({ data: buf, address: addr });
  } else if (flashOffset === 'full') {
    onLog('Downloading bundled UART Bridge firmware images...');
    const items = [
      { label: 'bootloader', address: profile.bootloaderOffset, url: `./firmware/${profile.prefix}.bootloader.bin` },
      { label: 'partitions', address: 0x8000, url: `./firmware/${profile.prefix}.partitions.bin` },
      { label: 'boot_app0', address: 0xe000, url: `./firmware/boot_app0.bin` },
      { label: 'firmware', address: 0x10000, url: `./firmware/${profile.prefix}.bin` },
    ];
    for (const item of items) {
      const resp = await fetch(item.url);
      if (!resp.ok) throw new Error(`Missing binary ${item.url} (${resp.status}).`);
      const buf = new Uint8Array(await resp.arrayBuffer());
      onLog(`Loaded ${item.label} @ 0x${item.address.toString(16)} (${buf.byteLength} bytes)`);
      fileArray.push({ data: buf, address: item.address });
    }
  } else {
    const appUrl = `./firmware/${profile.prefix}.bin`;
    const resp = await fetch(appUrl);
    if (!resp.ok) throw new Error(`Missing binary ${appUrl} (${resp.status}).`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    const addr = flashOffset === '0x0' ? 0x0 : 0x10000;
    fileArray.push({ data: buf, address: addr });
  }

  onLog('[2/4] Connecting to ROM bootloader...');
  const { ESPLoader, Transport } = await import('https://esm.sh/esptool-js@0.7.1');
  const espTransport = new Transport(port, false);
  const esploader = new ESPLoader({
    transport: espTransport,
    baudrate: 460800,
    romBaudrate: 115200,
    terminal: {
      clean: () => {},
      writeLine: (line) => onLog(line),
      write: (data) => {
        const cleaned = data.replace(/\r/g, '').trim();
        if (cleaned) onLog(cleaned);
      },
    },
  });

  let chip = '';
  try {
    chip = await esploader.main('default_reset');
  } catch {
    onLog('Default reset sync timed out; retrying direct no_reset sync...');
    try { await espTransport.disconnect(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
    chip = await esploader.main('no_reset');
  }
  onLog(`Connected to bootloader chip: ${chip || profile.label}`);

  onLog('[3/4] Writing flash memory...');
  const totalBytes = fileArray.reduce((acc, f) => acc + f.data.byteLength, 0);
  const isBundledFull = !customFile && flashOffset === 'full';

  await esploader.writeFlash({
    fileArray,
    flashSize: profile.flashSize,
    flashMode: isBundledFull ? 'dio' : 'keep',
    flashFreq: isBundledFull ? '80m' : 'keep',
    eraseAll: false,
    compress: true,
    reportProgress: (fileIndex, written, total) => {
      const prev = fileArray.slice(0, fileIndex).reduce((acc, f) => acc + f.data.byteLength, 0);
      const cur = fileArray[fileIndex]
        ? fileArray[fileIndex].data.byteLength * (written / Math.max(1, total))
        : written;
      const ratio = totalBytes > 0 ? (prev + cur) / totalBytes : written / Math.max(1, total);
      onProgress(Math.min(100, Math.round(ratio * 100)));
    },
  });

  onLog('[4/4] Flashing complete! Triggering reset...');
  let watchdogTriggered = false;
  if (boardId === 'esp32s3') {
    try {
      await esploader.writeReg(0x6000812c, 0);
      await esploader.writeReg(0x600080b0, 0x50d83aa1);
      await esploader.writeReg(0x6000809c, 2000);
      const curCfg0 = await esploader.readReg(0x60008098);
      const nextCfg0 = ((curCfg0 & 0x0fe3ffff) | 0xb01c0000) >>> 0;
      await esploader.writeReg(0x60008098, nextCfg0);
      await esploader.writeReg(0x600080a8, 0x80000000);
      watchdogTriggered = true;
      await new Promise((r) => setTimeout(r, 150));
    } catch {}
  }
  if (!watchdogTriggered) {
    try { await esploader.after('hard_reset'); } catch {}
  }
  try { await espTransport.disconnect(); } catch {}

  onProgress(100);
  onLog('Flash complete! Reconnecting in XIAO UART Bridge mode...');
  await new Promise((r) => setTimeout(r, 1200));
  if (webUsbDevice) {
    await openWebUsb(webUsbDevice, state.cfg, 0);
  } else {
    await openWebSerial(port, state.cfg);
  }
}
