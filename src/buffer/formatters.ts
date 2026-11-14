import { RingBufferEntry } from './RingBuffer';

export type ViewMode = 'ASCII' | 'HEX';

export interface ViewOptions {
  viewMode: ViewMode;
  showTimestamps: boolean;
  showInvisibleChars: boolean;
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  viewMode: 'ASCII',
  showTimestamps: false,
  showInvisibleChars: false,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return `${n}`;
}

export function formatTimeHMS(timestampMs: number): string {
  const d = new Date(timestampMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatTimeHMSms(timestampMs: number): string {
  const d = new Date(timestampMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

export function formatConnectedSeparator(
  deviceName: string,
  portIndex: number,
  timestampMs: number
): string {
  return `--- Connected [${deviceName} • Port ${portIndex}] (${formatTimeHMS(timestampMs)}) ---`;
}

export function formatDisconnectedSeparator(timestampMs: number): string {
  return `--- Disconnected (${formatTimeHMS(timestampMs)}) ---`;
}

export function formatSystemSeparator(text: string): string {
  return `\r\n\x1b[90m${text}\x1b[0m\r\n`;
}

export function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function encodeUtf8(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);
  return new TextEncoder().encode(text);
}

export function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = bytes[i].toString(16).toUpperCase().padStart(2, '0');
  }
  return parts.join(' ');
}

export function visualizeInvisibles(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\0') {
      out += '␀';
    } else if (ch === '\r') {
      out += '␍';
    } else if (ch === '\n') {
      out += '␊\r\n';
    } else {
      out += ch;
    }
  }
  return out;
}

export interface LineState {
  atLineStart: boolean;
}

function injectTimestampsWithState(text: string, tsPrefix: string, state: LineState): string {
  if (!text) return '';
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (state.atLineStart) {
      out += tsPrefix;
      state.atLineStart = false;
    }
    const ch = text[i];
    out += ch;
    if (ch === '\n') {
      state.atLineStart = true;
    }
  }
  return out;
}

export function formatEntryForTerminal(
  entry: RingBufferEntry,
  options: ViewOptions,
  lineState: LineState = { atLineStart: true }
): string {
  if (entry.type === 'SYSTEM_EVENT') {
    const sysText = entry.systemText ?? decodeUtf8(entry.data);
    lineState.atLineStart = true;
    return formatSystemSeparator(sysText);
  }

  const tsPrefix = options.showTimestamps
    ? `\x1b[90m[${formatTimeHMSms(entry.timestamp)}]\x1b[0m `
    : '';

  if (options.viewMode === 'HEX') {
    const hex = bytesToHex(entry.data);
    if (!hex) return '';
    const prefix = lineState.atLineStart ? '' : '\r\n';
    lineState.atLineStart = true;
    if (entry.type === 'TX') {
      return `${prefix}${tsPrefix}\x1b[36m[TX] ${hex}\x1b[0m\r\n`;
    }
    return `${prefix}${tsPrefix}${hex}\r\n`;
  }

  let body = decodeUtf8(entry.data);
  if (options.showInvisibleChars) {
    body = visualizeInvisibles(body);
  }

  if (options.showTimestamps) {
    body = injectTimestampsWithState(body, tsPrefix, lineState);
  } else if (body.length > 0) {
    lineState.atLineStart = body.endsWith('\n');
  }

  if (entry.type === 'TX') {
    return `\x1b[36m${body}\x1b[0m`;
  }
  return body;
}

export function replayEntriesToString(entries: RingBufferEntry[], options: ViewOptions): string {
  const lineState: LineState = { atLineStart: true };
  let result = '';
  for (let i = 0; i < entries.length; i++) {
    result += formatEntryForTerminal(entries[i], options, lineState);
  }
  return result;
}

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

export function exportRingBufferToLog(entries: RingBufferEntry[], options: ViewOptions): string {
  const raw = replayEntriesToString(entries, options);
  return stripAnsi(raw).replace(/\r\n/g, '\n');
}
