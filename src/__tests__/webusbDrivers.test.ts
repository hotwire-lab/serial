import { describe, expect, it } from 'vitest';
import {
  decodeFtdiPayload,
  detectDriverKindByVendor,
  encodeCdcLineCoding,
  encodeCh34xBaudFactors,
  encodeFtdiBaudDivisor,
  enumerateWebUsbPorts,
  formatVidPid,
  getDefaultControlLines,
} from '../serial/webusbDrivers';
import { WebUSBDevice } from '../serial/web-apis';

describe('WebUSB serial drivers & heuristics', () => {
  it('formats VID:PID and applies smart DTR/RTS defaults per device type', () => {
    expect(formatVidPid(0x303a, 0x1001)).toBe('303A:1001');
    expect(getDefaultControlLines(0x303a)).toEqual({ dtr: true, rts: false }); // Espressif native CDC
    expect(getDefaultControlLines(0x2e8a)).toEqual({ dtr: true, rts: false }); // RP2040 native CDC
    expect(getDefaultControlLines(0x10c4)).toEqual({ dtr: false, rts: false }); // CP210x bridge
    expect(getDefaultControlLines(0x1a86)).toEqual({ dtr: false, rts: false }); // CH340 bridge
    expect(getDefaultControlLines(0x0403)).toEqual({ dtr: false, rts: false }); // FTDI bridge
  });

  it('identifies USB UART bridges by Vendor ID', () => {
    expect(detectDriverKindByVendor(0x0403)).toBe('FTDI');
    expect(detectDriverKindByVendor(0x10c4)).toBe('CP210X');
    expect(detectDriverKindByVendor(0x1a86)).toBe('CH34X');
    expect(detectDriverKindByVendor(0x067b)).toBe('PL2303');
    expect(detectDriverKindByVendor(0x303a)).toBe('CDC_ACM');
  });

  it('encodes CDC 7-byte line coding structure in little-endian', () => {
    const encoded = encodeCdcLineCoding({
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 0,
      flowControl: 0,
    });
    expect(encoded.length).toBe(7);
    const dv = new DataView(encoded.buffer);
    expect(dv.getUint32(0, true)).toBe(115200);
    expect(dv.getUint8(4)).toBe(0);
    expect(dv.getUint8(5)).toBe(0);
    expect(dv.getUint8(6)).toBe(8);
  });

  it('strips 2-byte FTDI status header per USB packet boundary', () => {
    const packet1 = new Uint8Array([0x01, 0x60, 0x48, 0x69]); // "Hi"
    expect(Array.from(decodeFtdiPayload(packet1, 64))).toEqual([0x48, 0x69]);

    // Multi-packet buffer with 6-byte packet size for unit testing
    const combined = new Uint8Array([
      0x01, 0x60, 0x41, 0x42, 0x43, 0x44, // "ABCD"
      0x01, 0x60, 0x45, 0x46, // "EF"
    ]);
    expect(Array.from(decodeFtdiPayload(combined, 6))).toEqual([
      0x41, 0x42, 0x43, 0x44, 0x45, 0x46,
    ]);
  });

  it('calculates non-zero baud encoding factors for FTDI and CH34x', () => {
    const ftdi = encodeFtdiBaudDivisor(115200);
    expect(ftdi.value).toBeGreaterThan(0);

    const ch34x = encodeCh34xBaudFactors(115200);
    expect(ch34x.factor & 0x80).toBe(0x80);
  });

  it('enumerates composite dual-interface CDC-ACM ports cleanly', () => {
    const mockDevice = {
      vendorId: 0x303a,
      productId: 0x1001,
      configurations: [
        {
          configurationValue: 1,
          interfaces: [
            {
              interfaceNumber: 0,
              alternate: {
                alternateSetting: 0,
                interfaceClass: 2,
                interfaceSubclass: 2,
                interfaceProtocol: 0,
                endpoints: [{ endpointNumber: 2, direction: 'in', type: 'interrupt', packetSize: 8 }],
              },
            },
            {
              interfaceNumber: 1,
              alternate: {
                alternateSetting: 0,
                interfaceClass: 10,
                interfaceSubclass: 0,
                interfaceProtocol: 0,
                endpoints: [
                  { endpointNumber: 1, direction: 'out', type: 'bulk', packetSize: 64 },
                  { endpointNumber: 1, direction: 'in', type: 'bulk', packetSize: 64 },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as WebUSBDevice;

    const ports = enumerateWebUsbPorts(mockDevice);
    expect(ports).toHaveLength(1);
    expect(ports[0].driverKind).toBe('CDC_ACM');
    expect(ports[0].controlInterfaceNumber).toBe(0);
    expect(ports[0].dataInterfaceNumber).toBe(1);
  });
});
