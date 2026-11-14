// Self-contained ambient Web Serial, WebUSB, and Screen Wake Lock definitions
export {};

export type WebSerialParityType = 'none' | 'even' | 'odd';
export type WebSerialFlowControlType = 'none' | 'hardware';

export interface WebSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface WebSerialOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: WebSerialParityType;
  bufferSize?: number;
  flowControl?: WebSerialFlowControlType;
}

export interface WebSerialOutputSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

export interface WebSerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo(): WebSerialPortInfo;
  open(options: WebSerialOptions): Promise<void>;
  close(): Promise<void>;
  setSignals(signals?: WebSerialOutputSignals): Promise<void>;
  addEventListener(type: 'disconnect', listener: (ev: Event) => void): void;
  removeEventListener(type: 'disconnect', listener: (ev: Event) => void): void;
}

export interface WebSerialFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface WebSerial extends EventTarget {
  getPorts(): Promise<WebSerialPort[]>;
  requestPort(options?: { filters?: WebSerialFilter[] }): Promise<WebSerialPort>;
  addEventListener(type: 'connect' | 'disconnect', listener: (ev: Event & { target: WebSerialPort }) => void): void;
  removeEventListener(type: 'connect' | 'disconnect', listener: (ev: Event & { target: WebSerialPort }) => void): void;
}

export interface WebUSBEndpoint {
  readonly endpointNumber: number;
  readonly direction: 'in' | 'out';
  readonly type: 'bulk' | 'interrupt' | 'isochronous';
  readonly packetSize: number;
}

export interface WebUSBAlternateInterface {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly interfaceName?: string | null;
  readonly endpoints: readonly WebUSBEndpoint[];
}

export interface WebUSBInterface {
  readonly interfaceNumber: number;
  readonly alternate: WebUSBAlternateInterface;
  readonly alternates: readonly WebUSBAlternateInterface[];
  readonly claimed: boolean;
}

export interface WebUSBConfiguration {
  readonly configurationValue: number;
  readonly configurationName?: string | null;
  readonly interfaces: readonly WebUSBInterface[];
}

export interface WebUSBControlTransferParameters {
  requestType: 'standard' | 'class' | 'vendor';
  recipient: 'device' | 'interface' | 'endpoint' | 'other';
  request: number;
  value: number;
  index: number;
}

export interface WebUSBInTransferResult {
  readonly data?: DataView;
  readonly status: 'ok' | 'stall' | 'babble';
}

export interface WebUSBOutTransferResult {
  readonly bytesWritten: number;
  readonly status: 'ok' | 'stall' | 'babble';
}

export interface WebUSBDevice {
  readonly usbVersionMajor: number;
  readonly usbVersionMinor: number;
  readonly deviceClass: number;
  readonly deviceSubclass: number;
  readonly deviceProtocol: number;
  readonly vendorId: number;
  readonly productId: number;
  readonly manufacturerName?: string | null;
  readonly productName?: string | null;
  readonly serialNumber?: string | null;
  readonly configuration?: WebUSBConfiguration | null;
  readonly configurations: readonly WebUSBConfiguration[];
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  controlTransferIn(setup: WebUSBControlTransferParameters, length: number): Promise<WebUSBInTransferResult>;
  controlTransferOut(
    setup: WebUSBControlTransferParameters,
    data?: BufferSource
  ): Promise<WebUSBOutTransferResult>;
  transferIn(endpointNumber: number, length: number): Promise<WebUSBInTransferResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<WebUSBOutTransferResult>;
}

export interface WebUSBDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
}

export interface WebUSBConnectionEvent extends Event {
  readonly device: WebUSBDevice;
}

export interface WebUSB extends EventTarget {
  getDevices(): Promise<WebUSBDevice[]>;
  requestDevice(options: { filters: WebUSBDeviceFilter[] }): Promise<WebUSBDevice>;
  addEventListener(type: 'connect' | 'disconnect', listener: (ev: WebUSBConnectionEvent) => void): void;
  removeEventListener(type: 'connect' | 'disconnect', listener: (ev: WebUSBConnectionEvent) => void): void;
}

export interface ScreenWakeLockSentinel extends EventTarget {
  readonly released: boolean;
  release(): Promise<void>;
}

declare global {
  interface Navigator {
    readonly serial?: WebSerial;
    readonly usb?: WebUSB;
    readonly wakeLock?: {
      request(type: 'screen'): Promise<ScreenWakeLockSentinel>;
    };
  }
}

