import { SerialConfig } from './types';
import {
  WebUSBAlternateInterface,
  WebUSBDevice,
  WebUSBDeviceFilter,
  WebUSBEndpoint,
} from './web-apis';

export type UsbSerialDriverKind = 'CDC_ACM' | 'FTDI' | 'CP210X' | 'CH34X' | 'PL2303';

export interface WebUsbPortDescriptor {
  portIndex: number;
  driverKind: UsbSerialDriverKind;
  controlInterfaceNumber: number;
  dataInterfaceNumber: number;
  inEndpointNumber: number;
  outEndpointNumber: number;
  inPacketSize: number;
  label: string;
}

export const NATIVE_CDC_VIDS = new Set<number>([
  0x303a, // Espressif native USB
  0x2e8a, // Raspberry Pi RP2040 / Pico
  0x1915, // Nordic Semiconductor
  0x2341, // Arduino native USB
  0x1d50, // OpenMoko / STM CDC
  0x239a, // Adafruit
]);

export const WEBUSB_FILTERS: WebUSBDeviceFilter[] = [
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
  { classCode: 2, subclassCode: 2 }, // USB CDC-ACM
  { classCode: 239, subclassCode: 2, protocolCode: 1 }, // Composite IAD CDC
];

export function formatVidPid(vendorId: number, productId: number): string {
  const vid = vendorId.toString(16).toUpperCase().padStart(4, '0');
  const pid = productId.toString(16).toUpperCase().padStart(4, '0');
  return `${vid}:${pid}`;
}

export function detectDriverKindByVendor(vendorId: number): UsbSerialDriverKind {
  switch (vendorId) {
    case 0x0403:
      return 'FTDI';
    case 0x10c4:
      return 'CP210X';
    case 0x1a86:
      return 'CH34X';
    case 0x067b:
      return 'PL2303';
    default:
      return 'CDC_ACM';
  }
}

export function driverKindDisplayName(kind: UsbSerialDriverKind): string {
  switch (kind) {
    case 'FTDI':
      return 'FTDI';
    case 'CP210X':
      return 'CP210x';
    case 'CH34X':
      return 'CH34x';
    case 'PL2303':
      return 'PL2303';
    case 'CDC_ACM':
      return 'CDC-ACM';
  }
}

export function identifyChipName(vendorId: number): string {
  if (vendorId <= 0) return 'Web Serial';
  switch (vendorId) {
    case 0x0403:
      return 'FTDI';
    case 0x10c4:
      return 'CP210x';
    case 0x1a86:
      return 'CH34x';
    case 0x067b:
      return 'PL2303';
    case 0x303a:
      return 'Espressif CDC';
    case 0x2e8a:
      return 'RP2040 CDC';
    case 0x0483:
      return 'STM32 VCP';
    case 0x1915:
      return 'Nordic CDC';
    case 0x2341:
      return 'Arduino CDC';
    default:
      return 'CDC-ACM';
  }
}

export function getDefaultControlLines(vendorId: number, driverKind?: UsbSerialDriverKind): {
  dtr: boolean;
  rts: boolean;
} {
  const isNative =
    NATIVE_CDC_VIDS.has(vendorId) ||
    (vendorId === 0x0483 && (!driverKind || driverKind === 'CDC_ACM'));
  return {
    dtr: isNative,
    rts: false,
  };
}

function findBulkEndpoints(alt: WebUSBAlternateInterface): {
  inEp?: WebUSBEndpoint;
  outEp?: WebUSBEndpoint;
} {
  let inEp: WebUSBEndpoint | undefined;
  let outEp: WebUSBEndpoint | undefined;
  for (const ep of alt.endpoints) {
    if (ep.type !== 'bulk') continue;
    if (ep.direction === 'in' && !inEp) inEp = ep;
    if (ep.direction === 'out' && !outEp) outEp = ep;
  }
  return { inEp, outEp };
}

export function enumerateWebUsbPorts(device: WebUSBDevice): WebUsbPortDescriptor[] {
  const config = device.configuration ?? device.configurations[0];
  if (!config) return [];

  const vendorKind = detectDriverKindByVendor(device.vendorId);
  const interfaces = config.interfaces;
  const ports: WebUsbPortDescriptor[] = [];

  for (let i = 0; i < interfaces.length; i++) {
    const iface = interfaces[i];
    const alt = iface.alternate;
    const { inEp, outEp } = findBulkEndpoints(alt);
    if (!inEp || !outEp) continue;

    let controlIfaceNum = iface.interfaceNumber;
    let kind: UsbSerialDriverKind = vendorKind;

    // For CDC Data (class 10 / 0x0A), pair with the preceding CDC Comm interface (class 2) when present.
    if (alt.interfaceClass === 10) {
      kind = 'CDC_ACM';
      for (let j = i - 1; j >= 0; j--) {
        if (interfaces[j].alternate.interfaceClass === 2) {
          controlIfaceNum = interfaces[j].interfaceNumber;
          break;
        }
      }
    } else if (alt.interfaceClass === 2 && alt.interfaceSubclass === 2) {
      kind = 'CDC_ACM';
    }

    // Skip non-CDC vendor JTAG debug interfaces if VID isn't a known serial bridge and class is vendor-specific JTAG (0xFF/0xFF without matching vendor bridge)
    const isKnownBridge = device.vendorId in { 0x0403: 1, 0x10c4: 1, 0x1a86: 1, 0x067b: 1 };
    const isCdc = alt.interfaceClass === 10 || alt.interfaceClass === 2;
    if (!isKnownBridge && !isCdc && alt.interfaceClass === 0xff && ports.length > 0) {
      continue;
    }

    const idx = ports.length;
    ports.push({
      portIndex: idx,
      driverKind: kind,
      controlInterfaceNumber: controlIfaceNum,
      dataInterfaceNumber: iface.interfaceNumber,
      inEndpointNumber: inEp.endpointNumber,
      outEndpointNumber: outEp.endpointNumber,
      inPacketSize: inEp.packetSize || 64,
      label: `Port ${idx} (IF${iface.interfaceNumber})`,
    });
  }

  return ports;
}

export function encodeCdcLineCoding(config: SerialConfig): Uint8Array {
  const buf = new ArrayBuffer(7);
  const view = new DataView(buf);
  view.setUint32(0, config.baudRate, true);
  view.setUint8(4, config.stopBits === 2 ? 2 : 0);
  view.setUint8(5, config.parity); // 0=NONE, 1=ODD, 2=EVEN
  view.setUint8(6, config.dataBits);
  return new Uint8Array(buf);
}

export function encodeFtdiBaudDivisor(baudRate: number): { value: number; index: number } {
  if (baudRate >= 3_000_000) return { value: 0, index: 0 };
  if (baudRate === 2_000_000) return { value: 1, index: 0 };

  const baseClock = 48_000_000;
  const subDivisors = [0, 3, 2, 4, 1, 5, 6, 7];
  const divisor = Math.max(2, Math.round((baseClock / 16) / baudRate * 8));
  const intPart = divisor >> 3;
  const fracCode = subDivisors[divisor & 0x07];

  let encoded = intPart | (fracCode << 14);
  if (encoded === 1) {
    encoded = 0;
  } else if (encoded === 0x4001) {
    encoded = 1;
  }

  return {
    value: encoded & 0xffff,
    index: (encoded >> 16) & 0xffff,
  };
}

export function encodeCh34xBaudFactors(baudRate: number): { factor: number; divisor: number } {
  const ch34xClock = 12_000_000;
  const clampedBaud = Math.max(50, Math.min(3_000_000, baudRate));

  const factor25 = (1 << 12) * 8; // prescaler choices: 0x03 (~12MHz), 0x02 (~1.5MHz), 0x01 (~187.5kHz), 0x00 (~23.4kHz)
  void factor25;

  let a = 0;
  let b = 0;
  if (clampedBaud >= 1_500_000) {
    a = 3;
    b = 256 - Math.round(ch34xClock / clampedBaud);
  } else if (clampedBaud >= 24_000) {
    a = 3;
    b = 256 - Math.round((ch34xClock / 2) / clampedBaud);
    if (b < 2 || b > 255) {
      a = 2;
      b = 256 - Math.round((ch34xClock / 16) / clampedBaud);
    }
  } else if (clampedBaud >= 3_000) {
    a = 2;
    b = 256 - Math.round((ch34xClock / 16) / clampedBaud);
  } else if (clampedBaud >= 400) {
    a = 1;
    b = 256 - Math.round((ch34xClock / 128) / clampedBaud);
  } else {
    a = 0;
    b = 256 - Math.round((ch34xClock / 1024) / clampedBaud);
  }

  const clampedB = Math.max(0, Math.min(255, b));
  const factor = (clampedB << 8) | 0x80 | a;
  return { factor, divisor: 0 };
}

export function decodeFtdiPayload(raw: Uint8Array, packetSize = 64): Uint8Array {
  const effectivePacket = Math.max(3, packetSize);
  if (raw.byteLength <= 2) return new Uint8Array(0);
  if (raw.byteLength <= effectivePacket) {
    return raw.subarray(2);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let offset = 0; offset < raw.byteLength; offset += effectivePacket) {
    const end = Math.min(raw.byteLength, offset + effectivePacket);
    if (end - offset > 2) {
      const slice = raw.subarray(offset + 2, end);
      chunks.push(slice);
      total += slice.byteLength;
    }
  }
  const result = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return result;
}

export class WebUsbDriverSession {
  private readonly device: WebUSBDevice;
  private readonly port: WebUsbPortDescriptor;

  constructor(device: WebUSBDevice, port: WebUsbPortDescriptor) {
    this.device = device;
    this.port = port;
  }

  async init(config: SerialConfig, dtr: boolean, rts: boolean): Promise<void> {
    if (this.port.driverKind === 'FTDI') {
      const chIdx = this.port.dataInterfaceNumber + 1;
      await this.device.controlTransferOut({
        requestType: 'vendor',
        recipient: 'device',
        request: 0x00,
        value: 0x00,
        index: chIdx,
      });
    } else if (this.port.driverKind === 'CP210X') {
      await this.device.controlTransferOut({
        requestType: 'vendor',
        recipient: 'interface',
        request: 0x00,
        value: 0x0001,
        index: this.port.dataInterfaceNumber,
      });
    } else if (this.port.driverKind === 'CH34X') {
      await this.device.controlTransferOut({
        requestType: 'vendor',
        recipient: 'device',
        request: 0xa1,
        value: 0,
        index: 0,
      });
      await this.device.controlTransferOut({
        requestType: 'vendor',
        recipient: 'device',
        request: 0x9a,
        value: 0x0f2c,
        index: 0x0007,
      });
    }

    await this.setParameters(config);
    await this.setControlLines(dtr, rts);
  }

  async setParameters(config: SerialConfig): Promise<void> {
    switch (this.port.driverKind) {
      case 'CDC_ACM': {
        const payload = encodeCdcLineCoding(config);
        await this.device.controlTransferOut(
          {
            requestType: 'class',
            recipient: 'interface',
            request: 0x20,
            value: 0,
            index: this.port.controlInterfaceNumber,
          },
          payload as unknown as BufferSource
        );
        break;
      }

      case 'FTDI': {
        const chIdx = this.port.dataInterfaceNumber + 1;
        const { value, index } = encodeFtdiBaudDivisor(config.baudRate);
        await this.device.controlTransferOut({
          requestType: 'vendor',
          recipient: 'device',
          request: 0x03,
          value,
          index: (index << 8) | chIdx,
        });
        const ftdiParity = config.parity === 1 ? 0x0100 : config.parity === 2 ? 0x0200 : 0x0000;
        const ftdiStop = config.stopBits === 2 ? 0x1000 : 0x0000;
        await this.device.controlTransferOut({
          requestType: 'vendor',
          recipient: 'device',
          request: 0x04,
          value: (config.dataBits & 0xff) | ftdiParity | ftdiStop,
          index: chIdx,
        });
        await this.device.controlTransferOut({
          requestType: 'vendor',
          recipient: 'device',
          request: 0x02,
          value: config.flowControl === 1 ? 0x0100 : 0x0000,
          index: chIdx,
        });
        break;
      }

      case 'CP210X': {
        const baudBuf = new ArrayBuffer(4);
        new DataView(baudBuf).setUint32(0, config.baudRate, true);
        await this.device.controlTransferOut(
          {
            requestType: 'vendor',
            recipient: 'interface',
            request: 0x1e,
            value: 0,
            index: this.port.dataInterfaceNumber,
          },
          baudBuf
        );
        const cpParity = config.parity === 1 ? 0x0010 : config.parity === 2 ? 0x0020 : 0x0000;
        const cpStop = config.stopBits === 2 ? 0x0002 : 0x0000;
        await this.device.controlTransferOut({
          requestType: 'vendor',
          recipient: 'interface',
          request: 0x03,
          value: ((config.dataBits & 0x0f) << 8) | cpParity | cpStop,
          index: this.port.dataInterfaceNumber,
        });
        break;
      }

      case 'CH34X': {
        const { factor, divisor } = encodeCh34xBaudFactors(config.baudRate);
        await this.device.controlTransferOut({
          requestType: 'vendor',
          recipient: 'device',
          request: 0x9a,
          value: 0x1312,
          index: factor,
        });
        if (divisor !== 0) {
          await this.device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0x9a,
            value: 0x0f2c,
            index: divisor,
          });
        }
        let lcr = 0xc0; // enable RX & TX
        lcr |= config.dataBits === 7 ? 0x02 : 0x03;
        if (config.stopBits === 2) lcr |= 0x04;
        if (config.parity === 1) lcr |= 0x08;
        if (config.parity === 2) lcr |= 0x18;
        await this.device.controlTransferOut({
          requestType: 'vendor',
          recipient: 'device',
          request: 0x9a,
          value: 0x2518,
          index: lcr,
        });
        break;
      }

      case 'PL2303': {
        const payload = encodeCdcLineCoding(config);
        await this.device.controlTransferOut(
          {
            requestType: 'class',
            recipient: 'interface',
            request: 0x20,
            value: 0,
            index: 0,
          },
          payload as unknown as BufferSource
        );
        break;
      }
    }
  }

  async setControlLines(dtr: boolean, rts: boolean): Promise<void> {
    switch (this.port.driverKind) {
      case 'CDC_ACM':
      case 'PL2303':
        await this.device.controlTransferOut({
          requestType: 'class',
          recipient: 'interface',
          request: 0x22,
          value: (dtr ? 1 : 0) | (rts ? 2 : 0),
          index: this.port.controlInterfaceNumber,
        });
        break;

      case 'FTDI': {
        const chIdx = this.port.dataInterfaceNumber + 1;
        const val = (dtr ? 0x0101 : 0x0100) | (rts ? 0x0202 : 0x0200);
        await this.device.controlTransferOut({
          requestType: 'vendor',
          recipient: 'device',
          request: 0x01,
          value: val,
          index: chIdx,
        });
        break;
      }

      case 'CP210X': {
        const val = 0x0300 | (dtr ? 0x0001 : 0) | (rts ? 0x0002 : 0);
        await this.device.controlTransferOut({
          requestType: 'vendor',
          recipient: 'interface',
          request: 0x07,
          value: val,
          index: this.port.dataInterfaceNumber,
        });
        break;
      }

      case 'CH34X': {
        const lines = (~((dtr ? 0x20 : 0) | (rts ? 0x40 : 0))) & 0xff;
        await this.device.controlTransferOut({
          requestType: 'vendor',
          recipient: 'device',
          request: 0xa4,
          value: lines,
          index: 0,
        });
        break;
      }
    }
  }

  decodeIncoming(raw: Uint8Array): Uint8Array {
    if (this.port.driverKind === 'FTDI') {
      return decodeFtdiPayload(raw, this.port.inPacketSize);
    }
    return raw;
  }
}

