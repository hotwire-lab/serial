export type ConnectionState = 'LISTENING' | 'HANDSHAKING' | 'CONNECTED' | 'DISCONNECTED';

export type TransportPreference = 'auto' | 'webserial' | 'webusb';
export type ActiveTransportKind = 'webserial' | 'webusb' | 'demo' | 'none';

export type SerialDataBits = 7 | 8;
export type SerialStopBits = 1 | 2;
export type SerialParity = 0 | 1 | 2; // 0=NONE, 1=ODD, 2=EVEN
export type SerialFlowControl = 0 | 1; // 0=NONE, 1=RTS_CTS

export interface SerialConfig {
  baudRate: number;
  dataBits: SerialDataBits;
  stopBits: SerialStopBits;
  parity: SerialParity;
  flowControl: SerialFlowControl;
}

export interface DeviceProfileOverride {
  dtr: boolean;
  rts: boolean;
  portIndex: number;
}

export interface BrowserCapabilities {
  isSecureContext: boolean;
  hasWebSerial: boolean;
  hasWebUSB: boolean;
  isMobile: boolean;
  recommendedTransport: 'webserial' | 'webusb' | 'none';
}

export interface ConnectionStateSnapshot {
  state: ConnectionState;
  transport: ActiveTransportKind;
  deviceName: string | null;
  chipType: string | null;
  vendorId: number;
  productId: number;
  vidPid: string | null;
  portIndex: number;
  portCount: number;
  dtr: boolean;
  rts: boolean;
  baudRate: number;
  errorMessage: string | null;
}

export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 0,
  flowControl: 0,
};

export const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600] as const;

export const INITIAL_CONNECTION_SNAPSHOT: ConnectionStateSnapshot = {
  state: 'LISTENING',
  transport: 'none',
  deviceName: null,
  chipType: null,
  vendorId: 0,
  productId: 0,
  vidPid: null,
  portIndex: 0,
  portCount: 0,
  dtr: false,
  rts: false,
  baudRate: 115200,
  errorMessage: null,
};
