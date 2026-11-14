import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../buffer/RingBuffer';
import { decodeUtf8, encodeUtf8 } from '../buffer/formatters';

describe('RingBuffer', () => {
  it('enforces maxChunks capacity by evicting oldest entries', () => {
    const rb = new RingBuffer({ maxChunks: 3, maxBytes: 1024 });
    rb.push({ timestamp: 1, data: encodeUtf8('one'), type: 'RX' });
    rb.push({ timestamp: 2, data: encodeUtf8('two'), type: 'RX' });
    rb.push({ timestamp: 3, data: encodeUtf8('three'), type: 'RX' });
    rb.push({ timestamp: 4, data: encodeUtf8('four'), type: 'RX' });

    const all = rb.getAll();
    expect(rb.length).toBe(3);
    expect(all.map((e) => decodeUtf8(e.data))).toEqual(['two', 'three', 'four']);
  });

  it('enforces maxBytes budget', () => {
    const rb = new RingBuffer({ maxChunks: 100, maxBytes: 10 });
    rb.push({ timestamp: 1, data: encodeUtf8('12345'), type: 'RX' });
    rb.push({ timestamp: 2, data: encodeUtf8('67890'), type: 'RX' });
    expect(rb.totalBytes).toBe(10);

    rb.push({ timestamp: 3, data: encodeUtf8('abc'), type: 'TX' });
    const all = rb.getAll();
    expect(rb.totalBytes).toBe(8);
    expect(all.map((e) => decodeUtf8(e.data))).toEqual(['67890', 'abc']);
  });

  it('clears all entries cleanly', () => {
    const rb = new RingBuffer({ maxChunks: 10, maxBytes: 100 });
    rb.push({ timestamp: 1, data: encodeUtf8('hello'), type: 'RX' });
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.totalBytes).toBe(0);
    expect(rb.getAll()).toEqual([]);
  });
});

