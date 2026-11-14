export type EntryType = 'RX' | 'TX' | 'SYSTEM_EVENT';

export interface RingBufferEntry {
  id: number;
  timestamp: number;
  data: Uint8Array;
  type: EntryType;
  systemText?: string;
}

export interface RingBufferOptions {
  maxChunks?: number;
  maxBytes?: number;
}

export const DEFAULT_MAX_CHUNKS = 10_000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export class RingBuffer {
  private readonly maxChunks: number;
  private readonly maxBytes: number;
  private entries: (RingBufferEntry | undefined)[];
  private head = 0;
  private count = 0;
  private bytes = 0;
  private nextId = 1;

  constructor(options: RingBufferOptions = {}) {
    this.maxChunks = Math.max(1, options.maxChunks ?? DEFAULT_MAX_CHUNKS);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.entries = new Array<RingBufferEntry | undefined>(this.maxChunks);
  }

  get length(): number {
    return this.count;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  push(input: Omit<RingBufferEntry, 'id'>): RingBufferEntry {
    let data = input.data;
    if (data.byteLength > this.maxBytes) {
      data = data.slice(data.byteLength - this.maxBytes);
    }

    const entry: RingBufferEntry = {
      id: this.nextId++,
      timestamp: input.timestamp,
      data,
      type: input.type,
      systemText: input.systemText,
    };

    const incomingBytes = entry.data.byteLength;

    while (this.count > 0 && (this.count >= this.maxChunks || this.bytes + incomingBytes > this.maxBytes)) {
      this.evictOldest();
    }

    const tail = (this.head + this.count) % this.maxChunks;
    this.entries[tail] = entry;
    this.count += 1;
    this.bytes += incomingBytes;

    return entry;
  }

  getAll(): RingBufferEntry[] {
    const result: RingBufferEntry[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head + i) % this.maxChunks;
      result[i] = this.entries[idx]!;
    }
    return result;
  }

  clear(): void {
    this.entries.fill(undefined);
    this.head = 0;
    this.count = 0;
    this.bytes = 0;
  }

  private evictOldest(): void {
    if (this.count === 0) return;
    const oldest = this.entries[this.head];
    this.entries[this.head] = undefined;
    this.head = (this.head + 1) % this.maxChunks;
    this.count -= 1;
    if (oldest) {
      this.bytes = Math.max(0, this.bytes - oldest.data.byteLength);
    }
  }
}

