import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  formatFramingLabel,
  lineEndingToBytes,
  loadPreferences,
  nextLineEnding,
  savePreferences,
} from '../storage/preferencesStore';

describe('preferencesStore', () => {
  it('maps and cycles line endings consistently', () => {
    expect(lineEndingToBytes('CRLF')).toBe('\r\n');
    expect(lineEndingToBytes('LF')).toBe('\n');
    expect(lineEndingToBytes('CR')).toBe('\r');
    expect(lineEndingToBytes('RAW')).toBe('');

    expect(nextLineEnding('CRLF')).toBe('LF');
    expect(nextLineEnding('LF')).toBe('CR');
    expect(nextLineEnding('CR')).toBe('RAW');
    expect(nextLineEnding('RAW')).toBe('CRLF');
  });

  it('persists and reloads preferences and per-VID:PID overrides via fallback store', () => {
    savePreferences({
      ...DEFAULT_PREFERENCES,
      baudRate: 921600,
      fontSize: 16,
      deviceProfiles: {
        '303A:1001': { dtr: true, rts: false, portIndex: 1 },
      },
    });
    const loaded = loadPreferences();
    expect(loaded.baudRate).toBe(921600);
    expect(loaded.fontSize).toBe(16);
    expect(loaded.deviceProfiles['303A:1001']).toEqual({ dtr: true, rts: false, portIndex: 1 });
  });

  it('formats framing label cleanly', () => {
    expect(
      formatFramingLabel({
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 0,
        flowControl: 0,
      })
    ).toBe('8N1');
    expect(
      formatFramingLabel({
        baudRate: 9600,
        dataBits: 7,
        stopBits: 1,
        parity: 2,
        flowControl: 1,
      })
    ).toBe('7E1 RTS/CTS');
  });
});

