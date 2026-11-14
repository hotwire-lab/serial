import {
  BrowserCapabilities,
  ConnectionStateSnapshot,
  DEFAULT_SERIAL_CONFIG,
  DeviceProfileOverride,
  INITIAL_CONNECTION_SNAPSHOT,
  SerialConfig,
  TransportPreference,
} from './types';
import {
  ScreenWakeLockSentinel,
  WebSerialParityType,
  WebSerialPort,
  WebUSBDevice,
} from './web-apis';
import {
  WEBUSB_FILTERS,
  WebUsbDriverSession,
  WebUsbPortDescriptor,
  driverKindDisplayName,
  enumerateWebUsbPorts,
  formatVidPid,
  getDefaultControlLines,
  identifyChipName,
} from './webusbDrivers';
import { encodeUtf8 } from '../buffer/formatters';

export type StateListener = (snapshot: ConnectionStateSnapshot) => void;
export type DataListener = (bytes: Uint8Array) => void;

const FLUSH_INTERVAL_MS = 20;
const FLUSH_THRESHOLD_BYTES = 16 * 1024;

export function detectBrowserCapabilities(): BrowserCapabilities {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return {
      isSecureContext: false,
      hasWebSerial: false,
      hasWebUSB: false,
      isMobile: false,
      recommendedTransport: 'none',
    };
  }

  const ua = navigator.userAgent ?? '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  const hasWebSerial = 'serial' in navigator && Boolean(navigator.serial);
  const hasWebUSB = 'usb' in navigator && Boolean(navigator.usb);

  let recommendedTransport: 'webserial' | 'webusb' | 'none' = 'none';
  if (hasWebSerial && !isMobile) {
    recommendedTransport = 'webserial';
  } else if (hasWebUSB) {
    recommendedTransport = 'webusb';
  } else if (hasWebSerial) {
    recommendedTransport = 'webserial';
  }

  return {
    isSecureContext: Boolean(window.isSecureContext),
    hasWebSerial,
    hasWebUSB,
    isMobile,
    recommendedTransport,
  };
}

function toWebSerialParity(parity: SerialConfig['parity']): WebSerialParityType {
  if (parity === 1) return 'odd';
  if (parity === 2) return 'even';
  return 'none';
}

export class SerialManager {
  private snapshot: ConnectionStateSnapshot = { ...INITIAL_CONNECTION_SNAPSHOT };
  private serialConfig: SerialConfig = { ...DEFAULT_SERIAL_CONFIG };
  private transportPreference: TransportPreference = 'auto';
  private deviceProfiles: Record<string, DeviceProfileOverride> = {};

  private stateListeners = new Set<StateListener>();
  private dataListeners = new Set<DataListener>();

  // RX 20ms / 16KB batching queue
  private rxQueue: Uint8Array[] = [];
  private rxQueuedBytes = 0;
  private rxFlushTimer: number | null = null;

  // Web Serial handles
  private webSerialPort: WebSerialPort | null = null;
  private webSerialReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private webSerialWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

  // WebUSB handles
  private webUsbDevice: WebUSBDevice | null = null;
  private webUsbPorts: WebUsbPortDescriptor[] = [];
  private webUsbSession: WebUsbDriverSession | null = null;
  private webUsbReadActive = false;

  // Demo mode handles
  private demoTimer: number | null = null;
  private demoBuffer = '';
  private demoTick = 0;

  // Wake Lock
  private wakeLockSentinel: ScreenWakeLockSentinel | null = null;

  private sessionEpoch = 0;
  private initializedListeners = false;

  private readonly onHardwareConnect = () => {
    if (this.snapshot.state === 'LISTENING') {
      void this.probeAuthorizedDevices();
    }
  };

  private readonly onHardwareDisconnect = (ev: Event) => {
    if (this.snapshot.transport === 'webusb') {
      const usbEv = ev as Event & { device?: WebUSBDevice };
      if (!usbEv.device || usbEv.device === this.webUsbDevice) {
        void this.handleUnexpectedDisconnect('USB device unplugged');
      }
    } else if (this.snapshot.transport === 'webserial') {
      const serEv = ev as Event & { target?: WebSerialPort };
      if (!serEv.target || serEv.target === this.webSerialPort) {
        void this.handleUnexpectedDisconnect('Serial port disconnected');
      }
    }
  };

  private readonly onVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (this.snapshot.state === 'CONNECTED') {
        void this.acquireWakeLock();
      }
    }
  };

  init(): void {
    if (this.initializedListeners || typeof navigator === 'undefined') return;
    this.initializedListeners = true;

    navigator.serial?.addEventListener('connect', this.onHardwareConnect);
    navigator.serial?.addEventListener('disconnect', this.onHardwareDisconnect);
    navigator.usb?.addEventListener('connect', this.onHardwareConnect);
    navigator.usb?.addEventListener('disconnect', this.onHardwareDisconnect);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    void this.probeAuthorizedDevices();
  }

  destroy(): void {
    this.flushRxQueue();
    if (this.rxFlushTimer !== null) {
      window.clearTimeout(this.rxFlushTimer);
      this.rxFlushTimer = null;
    }
    if (typeof navigator !== 'undefined' && this.initializedListeners) {
      navigator.serial?.removeEventListener('connect', this.onHardwareConnect);
      navigator.serial?.removeEventListener('disconnect', this.onHardwareDisconnect);
      navigator.usb?.removeEventListener('connect', this.onHardwareConnect);
      navigator.usb?.removeEventListener('disconnect', this.onHardwareDisconnect);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
      }
    }
    this.initializedListeners = false;
    void this.disconnect(false);
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener({ ...this.snapshot });
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onData(listener: DataListener): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  getSnapshot(): ConnectionStateSnapshot {
    return { ...this.snapshot };
  }

  setDeviceProfiles(profiles: Record<string, DeviceProfileOverride>): void {
    this.deviceProfiles = { ...profiles };
  }

  setTransportPreference(pref: TransportPreference): void {
    this.transportPreference = pref;
  }

  resolveTransport(): 'webserial' | 'webusb' | 'none' {
    const caps = detectBrowserCapabilities();
    if (this.transportPreference === 'webserial' && caps.hasWebSerial) return 'webserial';
    if (this.transportPreference === 'webusb' && caps.hasWebUSB) return 'webusb';
    return caps.recommendedTransport;
  }

  async probeAuthorizedDevices(): Promise<void> {
    if (this.snapshot.state === 'CONNECTED' || this.snapshot.state === 'HANDSHAKING') return;
    const preferred = this.resolveTransport();

    try {
      if (preferred === 'webserial' && navigator.serial) {
        const ports = await navigator.serial.getPorts();
        if (ports.length > 0) {
          await this.openWebSerialPort(ports[0]);
          return;
        }
      }
      if ((preferred === 'webusb' || preferred === 'webserial') && navigator.usb) {
        const devices = await navigator.usb.getDevices();
        if (devices.length > 0) {
          await this.openWebUsbDevice(devices[0]);
        }
      }
    } catch {
      // Auto-reconnect probe stays silent if device is busy elsewhere
    }
  }

  async connectWithPicker(overrideTransport?: 'webserial' | 'webusb'): Promise<void> {
    const caps = detectBrowserCapabilities();
    if (!caps.isSecureContext) {
      this.updateSnapshot({
        state: 'LISTENING',
        errorMessage: 'WebSerial / WebUSB requires HTTPS (or localhost).',
      });
      return;
    }

    const transport = overrideTransport ?? this.resolveTransport();
    if (transport === 'none') {
      this.updateSnapshot({
        state: 'LISTENING',
        errorMessage: 'This browser does not support Web Serial or WebUSB. Use Chrome/Edge or launch Demo.',
      });
      return;
    }

    try {
      if (transport === 'webserial' && navigator.serial) {
        const port = await navigator.serial.requestPort();
        await this.openWebSerialPort(port);
      } else if (navigator.usb) {
        const device = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
        await this.openWebUsbDevice(device);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No port selected') || msg.includes('No device selected') || msg.includes('NotFoundError')) {
        this.updateSnapshot({ state: 'LISTENING', errorMessage: null });
      } else {
        this.updateSnapshot({ state: 'LISTENING', errorMessage: msg });
      }
    }
  }

  async startDemo(): Promise<void> {
    await this.closeTransportHandles();
    const epoch = ++this.sessionEpoch;
    this.demoTick = 0;
    this.demoBuffer = '';

    this.updateSnapshot({
      state: 'CONNECTED',
      transport: 'demo',
      deviceName: 'ESP32-S3 Demo',
      chipType: 'Simulated CDC',
      vendorId: 0x303a,
      productId: 0x1001,
      vidPid: '303A:1001',
      portIndex: 0,
      portCount: 2,
      dtr: true,
      rts: false,
      baudRate: this.serialConfig.baudRate,
      errorMessage: null,
    });

    this.enqueueRxBytes(
      encodeUtf8(
        '\x1b[32mHotWire Simulated ESP32-S3 Shell Ready\x1b[0m\r\n' +
          'Type \x1b[33mhelp\x1b[0m, \x1b[33mstatus\x1b[0m, or \x1b[33mstream\x1b[0m to test RX/TX & ANSI.\r\nesp32> '
      )
    );

    this.demoTimer = window.setInterval(() => {
      if (epoch !== this.sessionEpoch) return;
      this.demoTick += 1;
      const vbat = (3.28 + Math.sin(this.demoTick * 0.4) * 0.04).toFixed(2);
      const rssi = -54 - (this.demoTick % 7);
      this.enqueueRxBytes(
        encodeUtf8(`\r\n[telemetry] tick=${this.demoTick} vbat=${vbat}V rssi=${rssi}dBm\r\nesp32> `)
      );
    }, 3500);
  }

  async disconnect(emitDisconnectedState = true): Promise<void> {
    this.sessionEpoch += 1;
    this.flushRxQueue();
    await this.closeTransportHandles();
    await this.releaseWakeLock();

    if (emitDisconnectedState && this.snapshot.state === 'CONNECTED') {
      this.updateSnapshot({
        ...INITIAL_CONNECTION_SNAPSHOT,
        state: 'DISCONNECTED',
        baudRate: this.serialConfig.baudRate,
      });
    }

    this.updateSnapshot({
      ...INITIAL_CONNECTION_SNAPSHOT,
      state: 'LISTENING',
      baudRate: this.serialConfig.baudRate,
      errorMessage: null,
    });
  }

  async selectPort(portIndex: number): Promise<void> {
    if (this.snapshot.transport === 'demo') {
      this.updateSnapshot({
        portIndex: portIndex % 2,
        dtr: true,
        rts: false,
      });
      this.enqueueRxBytes(encodeUtf8(`\r\n\x1b[90mSwitched Demo Port -> P${portIndex % 2}\x1b[0m\r\nesp32> `));
      return;
    }

    if (this.snapshot.transport === 'webusb' && this.webUsbDevice) {
      const target = this.webUsbPorts[portIndex];
      if (!target) return;
      await this.openWebUsbPort(this.webUsbDevice, target);
    }
  }

  async configureSerial(config: SerialConfig): Promise<void> {
    this.serialConfig = { ...config };
    this.updateSnapshot({ baudRate: config.baudRate });

    if (this.snapshot.state !== 'CONNECTED') return;

    if (this.snapshot.transport === 'webusb' && this.webUsbSession) {
      await this.webUsbSession.setParameters(config);
    } else if (this.snapshot.transport === 'webserial' && this.webSerialPort) {
      const currentPort = this.webSerialPort;
      await this.openWebSerialPort(currentPort);
    }
  }

  async setControlLines(dtr: boolean, rts: boolean): Promise<void> {
    this.updateSnapshot({ dtr, rts });
    if (this.snapshot.state !== 'CONNECTED') return;

    try {
      if (this.snapshot.transport === 'webusb' && this.webUsbSession) {
        await this.webUsbSession.setControlLines(dtr, rts);
      } else if (this.snapshot.transport === 'webserial' && this.webSerialPort) {
        await this.webSerialPort.setSignals({
          dataTerminalReady: dtr,
          requestToSend: rts,
        });
      }
    } catch {
      // Some adapters don't implement modem control signals cleanly
    }
  }

  async pulseReset(): Promise<void> {
    if (this.snapshot.state !== 'CONNECTED') return;

    if (this.snapshot.transport === 'demo') {
      this.enqueueRxBytes(encodeUtf8('\r\n\x1b[33m[RESET] ESP32-S3 RST:0x1 (POWERON)\x1b[0m\r\nesp32> '));
      return;
    }

    const prevDtr = this.snapshot.dtr;
    const prevRts = this.snapshot.rts;
    await this.setControlLines(false, true);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    await this.setControlLines(prevDtr, prevRts);
  }

  async writeBytes(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0 || this.snapshot.state !== 'CONNECTED') return;

    if (this.snapshot.transport === 'demo') {
      this.handleDemoInput(bytes);
      return;
    }

    if (this.snapshot.transport === 'webusb' && this.webUsbDevice) {
      const desc = this.webUsbPorts[this.snapshot.portIndex];
      if (!desc) return;
      await this.webUsbDevice.transferOut(desc.outEndpointNumber, bytes as unknown as BufferSource);
      return;
    }

    if (this.snapshot.transport === 'webserial' && this.webSerialWriter) {
      await this.webSerialWriter.write(bytes);
    }
  }

  private async openWebSerialPort(port: WebSerialPort): Promise<void> {
    await this.closeTransportHandles();
    const epoch = ++this.sessionEpoch;

    const info = port.getInfo();
    const vid = info.usbVendorId ?? 0;
    const pid = info.usbProductId ?? 0;
    const vidPid = vid > 0 || pid > 0 ? formatVidPid(vid, pid) : 'WEB:SERIAL';
    const chipType = identifyChipName(vid);
    const deviceName = vid > 0 ? `${chipType} (${vidPid})` : 'Web Serial Port';

    this.updateSnapshot({
      state: 'HANDSHAKING',
      transport: 'webserial',
      deviceName,
      chipType,
      vendorId: vid,
      productId: pid,
      vidPid,
      portIndex: 0,
      portCount: 1,
      baudRate: this.serialConfig.baudRate,
      errorMessage: null,
    });

    try {
      await port.open({
        baudRate: this.serialConfig.baudRate,
        dataBits: this.serialConfig.dataBits,
        stopBits: this.serialConfig.stopBits,
        parity: toWebSerialParity(this.serialConfig.parity),
        flowControl: this.serialConfig.flowControl === 1 ? 'hardware' : 'none',
        bufferSize: 16384,
      });

      if (epoch !== this.sessionEpoch) {
        try {
          await port.close();
        } catch {
          // Ignore close failure if aborted
        }
        return;
      }

      const saved = this.deviceProfiles[vidPid];
      const defaults = getDefaultControlLines(vid);
      const dtr = saved?.dtr ?? defaults.dtr;
      const rts = saved?.rts ?? defaults.rts;

      this.webSerialPort = port;
      try {
        await port.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
      } catch {
        // Virtual COM ports may omit signal lines
      }

      if (port.writable) {
        this.webSerialWriter = port.writable.getWriter();
      }

      this.updateSnapshot({
        state: 'CONNECTED',
        transport: 'webserial',
        deviceName,
        chipType,
        vendorId: vid,
        productId: pid,
        vidPid,
        portIndex: 0,
        portCount: 1,
        dtr,
        rts,
        baudRate: this.serialConfig.baudRate,
        errorMessage: null,
      });

      void this.acquireWakeLock();
      void this.runWebSerialReadLoop(port, epoch);
    } catch (err) {
      await this.closeTransportHandles();
      const message = err instanceof Error ? err.message : String(err);
      this.updateSnapshot({
        ...INITIAL_CONNECTION_SNAPSHOT,
        state: 'LISTENING',
        baudRate: this.serialConfig.baudRate,
        errorMessage: `Failed to open serial port: ${message}`,
      });
    }
  }

  private async runWebSerialReadLoop(port: WebSerialPort, epoch: number): Promise<void> {
    if (!port.readable) return;
    const reader = port.readable.getReader();
    this.webSerialReader = reader;

    try {
      while (epoch === this.sessionEpoch) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          this.enqueueRxBytes(value);
        }
      }
    } catch (err) {
      if (epoch === this.sessionEpoch) {
        const message = err instanceof Error ? err.message : String(err);
        await this.handleUnexpectedDisconnect(message);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore already-released reader
      }
      if (this.webSerialReader === reader) {
        this.webSerialReader = null;
      }
    }
  }

  private async openWebUsbDevice(device: WebUSBDevice): Promise<void> {
    await this.closeTransportHandles();
    const epoch = ++this.sessionEpoch;

    const vidPid = formatVidPid(device.vendorId, device.productId);
    const chipType = identifyChipName(device.vendorId);
    const deviceName = device.productName?.trim() || `${chipType} (${vidPid})`;

    this.updateSnapshot({
      state: 'HANDSHAKING',
      transport: 'webusb',
      deviceName,
      chipType,
      vendorId: device.vendorId,
      productId: device.productId,
      vidPid,
      portIndex: 0,
      portCount: 0,
      baudRate: this.serialConfig.baudRate,
      errorMessage: null,
    });

    try {
      if (!device.opened) {
        await device.open();
      }
      if (!device.configuration) {
        await device.selectConfiguration(1);
      }

      if (epoch !== this.sessionEpoch) return;

      const ports = enumerateWebUsbPorts(device);
      if (ports.length === 0) {
        await device.close();
        this.updateSnapshot({
          ...INITIAL_CONNECTION_SNAPSHOT,
          state: 'LISTENING',
          baudRate: this.serialConfig.baudRate,
          errorMessage: 'No serial bulk endpoints found on this USB device.',
        });
        return;
      }

      this.webUsbDevice = device;
      this.webUsbPorts = ports;

      const saved = this.deviceProfiles[vidPid];
      const targetIdx = Math.min(Math.max(saved?.portIndex ?? 0, 0), ports.length - 1);
      await this.openWebUsbPort(device, ports[targetIdx], epoch);
    } catch (err) {
      await this.closeTransportHandles();
      const message = err instanceof Error ? err.message : String(err);
      const hint = message.toLowerCase().includes('claim')
        ? `${message} (Another app or OS kernel driver may hold this USB interface.)`
        : message;
      this.updateSnapshot({
        ...INITIAL_CONNECTION_SNAPSHOT,
        state: 'LISTENING',
        baudRate: this.serialConfig.baudRate,
        errorMessage: hint,
      });
    }
  }

  private async openWebUsbPort(
    device: WebUSBDevice,
    descriptor: WebUsbPortDescriptor,
    existingEpoch?: number
  ): Promise<void> {
    const epoch = existingEpoch ?? ++this.sessionEpoch;
    this.webUsbReadActive = false;

    // Release any previously claimed interfaces when switching ports
    for (const prevPort of this.webUsbPorts) {
      try {
        await device.releaseInterface(prevPort.dataInterfaceNumber);
      } catch {
        // Ignore unclaimed interface
      }
      if (prevPort.controlInterfaceNumber !== prevPort.dataInterfaceNumber) {
        try {
          await device.releaseInterface(prevPort.controlInterfaceNumber);
        } catch {
          // Ignore unclaimed control interface
        }
      }
    }

    if (descriptor.controlInterfaceNumber !== descriptor.dataInterfaceNumber) {
      try {
        await device.claimInterface(descriptor.controlInterfaceNumber);
      } catch {
        // Control interface may already be claimed or optional on composite adapters
      }
    }
    await device.claimInterface(descriptor.dataInterfaceNumber);

    if (epoch !== this.sessionEpoch) return;

    const vidPid = formatVidPid(device.vendorId, device.productId);
    const saved = this.deviceProfiles[vidPid];
    const defaults = getDefaultControlLines(device.vendorId, descriptor.driverKind);
    const dtr = saved?.dtr ?? defaults.dtr;
    const rts = saved?.rts ?? defaults.rts;

    const session = new WebUsbDriverSession(device, descriptor);
    await session.init(this.serialConfig, dtr, rts);
    this.webUsbSession = session;

    const chipType =
      device.vendorId === 0x303a || device.vendorId === 0x2e8a || device.vendorId === 0x0483
        ? identifyChipName(device.vendorId)
        : driverKindDisplayName(descriptor.driverKind);
    const deviceName = device.productName?.trim() || `${chipType} (${vidPid})`;

    this.updateSnapshot({
      state: 'CONNECTED',
      transport: 'webusb',
      deviceName,
      chipType,
      vendorId: device.vendorId,
      productId: device.productId,
      vidPid,
      portIndex: descriptor.portIndex,
      portCount: this.webUsbPorts.length,
      dtr,
      rts,
      baudRate: this.serialConfig.baudRate,
      errorMessage: null,
    });

    void this.acquireWakeLock();
    this.webUsbReadActive = true;
    void this.runWebUsbReadLoop(device, descriptor, session, epoch);
  }

  private async runWebUsbReadLoop(
    device: WebUSBDevice,
    descriptor: WebUsbPortDescriptor,
    session: WebUsbDriverSession,
    epoch: number
  ): Promise<void> {
    const readSize = Math.max(64, descriptor.inPacketSize);
    while (this.webUsbReadActive && epoch === this.sessionEpoch && device.opened) {
      try {
        const result = await device.transferIn(descriptor.inEndpointNumber, readSize);
        if (!this.webUsbReadActive || epoch !== this.sessionEpoch) break;
        if (result.status === 'ok' && result.data && result.data.byteLength > 0) {
          const raw = new Uint8Array(
            result.data.buffer,
            result.data.byteOffset,
            result.data.byteLength
          );
          const decoded = session.decodeIncoming(raw);
          if (decoded.byteLength > 0) {
            this.enqueueRxBytes(decoded);
          }
        }
      } catch (err) {
        if (this.webUsbReadActive && epoch === this.sessionEpoch) {
          const msg = err instanceof Error ? err.message : String(err);
          await this.handleUnexpectedDisconnect(msg);
        }
        break;
      }
    }
  }

  private async handleUnexpectedDisconnect(errorMsg: string): Promise<void> {
    this.sessionEpoch += 1;
    this.flushRxQueue();
    await this.closeTransportHandles();
    await this.releaseWakeLock();

    if (this.snapshot.state === 'CONNECTED') {
      this.updateSnapshot({
        ...INITIAL_CONNECTION_SNAPSHOT,
        state: 'DISCONNECTED',
        baudRate: this.serialConfig.baudRate,
        errorMessage: errorMsg,
      });
    }

    this.updateSnapshot({
      ...INITIAL_CONNECTION_SNAPSHOT,
      state: 'LISTENING',
      baudRate: this.serialConfig.baudRate,
      errorMessage: errorMsg,
    });
  }

  private async closeTransportHandles(): Promise<void> {
    if (this.demoTimer !== null) {
      window.clearInterval(this.demoTimer);
      this.demoTimer = null;
    }

    this.webUsbReadActive = false;
    this.webUsbSession = null;

    if (this.webSerialReader) {
      try {
        await this.webSerialReader.cancel();
      } catch {
        // Ignore cancel failure
      }
      try {
        this.webSerialReader.releaseLock();
      } catch {
        // Ignore releaseLock failure
      }
      this.webSerialReader = null;
    }

    if (this.webSerialWriter) {
      try {
        await this.webSerialWriter.close();
      } catch {
        // Ignore close failure
      }
      try {
        this.webSerialWriter.releaseLock();
      } catch {
        // Ignore releaseLock failure
      }
      this.webSerialWriter = null;
    }

    if (this.webSerialPort) {
      try {
        await this.webSerialPort.close();
      } catch {
        // Ignore port close error
      }
      this.webSerialPort = null;
    }

    if (this.webUsbDevice) {
      for (const p of this.webUsbPorts) {
        try {
          await this.webUsbDevice.releaseInterface(p.dataInterfaceNumber);
        } catch {
          // Ignore already-released interface
        }
        if (p.controlInterfaceNumber !== p.dataInterfaceNumber) {
          try {
            await this.webUsbDevice.releaseInterface(p.controlInterfaceNumber);
          } catch {
            // Ignore
          }
        }
      }
      try {
        if (this.webUsbDevice.opened) {
          await this.webUsbDevice.close();
        }
      } catch {
        // Ignore USB close error
      }
      this.webUsbDevice = null;
      this.webUsbPorts = [];
    }
  }

  private handleDemoInput(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    if (text === '\x03') {
      this.demoBuffer = '';
      this.enqueueRxBytes(encodeUtf8('^C\r\nesp32> '));
      return;
    }
    if (text === '\x1b[A') {
      this.enqueueRxBytes(encodeUtf8('status'));
      this.demoBuffer = 'status';
      return;
    }
    if (text === '\x1b[B') {
      this.demoBuffer = '';
      this.enqueueRxBytes(encodeUtf8('\r\nesp32> '));
      return;
    }
    if (text === '\t') {
      this.enqueueRxBytes(encodeUtf8('help  status  reboot  stream'));
      return;
    }

    this.demoBuffer += text;
    if (!this.demoBuffer.includes('\r') && !this.demoBuffer.includes('\n')) {
      return;
    }

    const lines = this.demoBuffer.split(/[\r\n]+/);
    this.demoBuffer = lines.pop() ?? '';
    for (const rawCmd of lines) {
      const cmd = rawCmd.trim().toLowerCase();
      if (!cmd) {
        this.enqueueRxBytes(encodeUtf8('\r\nesp32> '));
      } else if (cmd === 'help') {
        this.enqueueRxBytes(
          encodeUtf8('\r\nCommands: help, status, reboot, stream, AT\r\nesp32> ')
        );
      } else if (cmd === 'status') {
        this.enqueueRxBytes(
          encodeUtf8(
            `\r\nUptime: ${this.demoTick * 3}s | Baud: ${this.serialConfig.baudRate} | ` +
              `DTR=${this.snapshot.dtr ? 1 : 0} RTS=${this.snapshot.rts ? 1 : 0}\r\nesp32> `
          )
        );
      } else if (cmd === 'at') {
        this.enqueueRxBytes(encodeUtf8('\r\nOK\r\nesp32> '));
      } else if (cmd === 'reboot') {
        this.enqueueRxBytes(
          encodeUtf8('\r\n\x1b[33mRebooting ESP32-S3...\x1b[0m\r\nESP-ROM:esp32s3-20210327\r\nesp32> ')
        );
      } else if (cmd === 'stream') {
        this.enqueueRxBytes(
          encodeUtf8(
            '\r\n\x1b[36m[I] ADC CH0=1842 CH1=2049 TEMP=36.4C\x1b[0m\r\n' +
              '\x1b[32m[I] WiFi: connected RSSI=-55dBm IP=192.168.1.42\x1b[0m\r\nesp32> '
          )
        );
      } else {
        this.enqueueRxBytes(encodeUtf8(`\r\nEcho: ${rawCmd}\r\nesp32> `));
      }
    }
  }

  private enqueueRxBytes(chunk: Uint8Array): void {
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    this.rxQueue.push(copy);
    this.rxQueuedBytes += copy.byteLength;

    if (this.rxQueuedBytes >= FLUSH_THRESHOLD_BYTES) {
      this.flushRxQueue();
      return;
    }

    if (this.rxFlushTimer === null && typeof window !== 'undefined') {
      this.rxFlushTimer = window.setTimeout(() => {
        this.rxFlushTimer = null;
        this.flushRxQueue();
      }, FLUSH_INTERVAL_MS);
    }
  }

  private flushRxQueue(): void {
    if (this.rxFlushTimer !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.rxFlushTimer);
      this.rxFlushTimer = null;
    }
    if (this.rxQueue.length === 0) return;

    const merged = new Uint8Array(this.rxQueuedBytes);
    let offset = 0;
    for (const part of this.rxQueue) {
      merged.set(part, offset);
      offset += part.byteLength;
    }
    this.rxQueue = [];
    this.rxQueuedBytes = 0;

    for (const listener of this.dataListeners) {
      listener(merged);
    }
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
    if (this.wakeLockSentinel && !this.wakeLockSentinel.released) return;
    try {
      this.wakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch {
      // Wake lock permission can be denied in background or battery-saver mode
    }
  }

  private async releaseWakeLock(): Promise<void> {
    if (!this.wakeLockSentinel) return;
    try {
      await this.wakeLockSentinel.release();
    } catch {
      // Ignore already released sentinel
    }
    this.wakeLockSentinel = null;
  }

  private updateSnapshot(partial: Partial<ConnectionStateSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial };
    const snapCopy = { ...this.snapshot };
    for (const listener of this.stateListeners) {
      listener(snapCopy);
    }
  }
}

export const serialManager = new SerialManager();
