import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../buffer/RingBuffer';
import {
  bytesToHex,
  encodeUtf8,
  exportRingBufferToLog,
  replayEntriesToString,
  visualizeInvisibles,
} from '../buffer/formatters';

describe('Terminal formatters', () => {
  it('formats bytes cleanly into uppercase HEX strings', () => {
    expect(bytesToHex(new Uint8Array([0x0a, 0x41, 0xff, 0x00]))).toBe('0A 41 FF 00');
  });

  it('renders invisible control characters when toggled', () => {
    expect(visualizeInvisibles('AT\r\n\0OK')).toBe('AT␍␊\r\n␀OK');
  });

  it('non-destructively switches between ASCII, HEX, Timestamps, and Clean Log Export', () => {
    const rb = new RingBuffer();
    const ts = new Date(2026, 0, 1, 14, 5, 9, 42).getTime();
    rb.push({ timestamp: ts, data: encodeUtf8('Boot\r\n'), type: 'RX' });
    rb.push({ timestamp: ts + 100, data: encodeUtf8('help\r\n'), type: 'TX' });

    const ascii = replayEntriesToString(rb.getAll(), {
      viewMode: 'ASCII',
      showTimestamps: false,
      showInvisibleChars: false,
    });
    expect(ascii).toContain('Boot\r\n');
    expect(ascii).toContain('\x1b[36mhelp\r\n\x1b[0m');

    const hex = replayEntriesToString(rb.getAll(), {
      viewMode: 'HEX',
      showTimestamps: false,
      showInvisibleChars: false,
    });
    expect(hex).toContain('42 6F 6F 74 0D 0A');
    expect(hex).toContain('[TX] 68 65 6C 70 0D 0A');

    const withTs = replayEntriesToString(rb.getAll(), {
      viewMode: 'ASCII',
      showTimestamps: true,
      showInvisibleChars: false,
    });
    expect(withTs).toContain('14:05:09.042');

    const cleanExport = exportRingBufferToLog(rb.getAll(), {
      viewMode: 'ASCII',
      showTimestamps: false,
      showInvisibleChars: false,
    });
    expect(cleanExport).toBe('Boot\nhelp\n');
  });
});

