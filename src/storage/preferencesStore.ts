import { DeviceProfileOverride, SerialConfig, TransportPreference } from '../serial/types';
import { ViewMode } from '../buffer/formatters';

export type LineEnding = 'CRLF' | 'LF' | 'CR' | 'RAW';

export interface MacroItem {
  id: string;
  label: string;
  payload: string;
  lineEnding: LineEnding;
}

export interface HotWirePreferences {
  baudRate: number;
  dataBits: 7 | 8;
  stopBits: 1 | 2;
  parity: 0 | 1 | 2;
  flowControl: 0 | 1;
  lineEnding: LineEnding;
  localEcho: boolean;
  viewMode: ViewMode;
  showTimestamps: boolean;
  showInvisibleChars: boolean;
  fontSize: number;
  transportPreference: TransportPreference;
  macros: MacroItem[];
  deviceProfiles: Record<string, DeviceProfileOverride>;
}

const PREFS_KEY = 'hotwire_pwa_preferences_v1';

export const DEFAULT_MACROS: MacroItem[] = [
  { id: 'help', label: 'help', payload: 'help', lineEnding: 'CRLF' },
  { id: 'status', label: 'status', payload: 'status', lineEnding: 'CRLF' },
  { id: 'reboot', label: 'reboot', payload: 'reboot', lineEnding: 'CRLF' },
  { id: 'at', label: 'AT', payload: 'AT', lineEnding: 'CRLF' },
];

export const DEFAULT_PREFERENCES: HotWirePreferences = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 0,
  flowControl: 0,
  lineEnding: 'CRLF',
  localEcho: true,
  viewMode: 'ASCII',
  showTimestamps: false,
  showInvisibleChars: false,
  fontSize: 13,
  transportPreference: 'auto',
  macros: DEFAULT_MACROS,
  deviceProfiles: {},
};

const memoryFallback = new Map<string, string>();

function readRaw(): string | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(PREFS_KEY);
    }
  } catch {
    // Fallback when storage access is restricted
  }
  return memoryFallback.get(PREFS_KEY) ?? null;
}

function writeRaw(serialized: string): void {
  memoryFallback.set(PREFS_KEY, serialized);
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(PREFS_KEY, serialized);
    }
  } catch {
    // Ignore storage quota / private browsing errors
  }
}

export function loadPreferences(): HotWirePreferences {
  try {
    const raw = readRaw();
    if (!raw) {
      return {
        ...DEFAULT_PREFERENCES,
        macros: DEFAULT_MACROS.map((m) => ({ ...m })),
        deviceProfiles: {},
      };
    }
    const parsed = JSON.parse(raw) as Partial<HotWirePreferences>;
    return {
      ...DEFAULT_PREFERENCES,
      ...parsed,
      macros:
        Array.isArray(parsed.macros) && parsed.macros.length > 0
          ? parsed.macros.map((m) => ({ ...m }))
          : DEFAULT_MACROS.map((m) => ({ ...m })),
      deviceProfiles:
        parsed.deviceProfiles && typeof parsed.deviceProfiles === 'object'
          ? { ...parsed.deviceProfiles }
          : {},
    };
  } catch {
    return {
      ...DEFAULT_PREFERENCES,
      macros: DEFAULT_MACROS.map((m) => ({ ...m })),
      deviceProfiles: {},
    };
  }
}

export function savePreferences(prefs: HotWirePreferences): void {
  writeRaw(JSON.stringify(prefs));
}

export function lineEndingToBytes(lineEnding: LineEnding): string {
  switch (lineEnding) {
    case 'CRLF':
      return '\r\n';
    case 'LF':
      return '\n';
    case 'CR':
      return '\r';
    case 'RAW':
      return '';
  }
}

export function nextLineEnding(current: LineEnding): LineEnding {
  const order: LineEnding[] = ['CRLF', 'LF', 'CR', 'RAW'];
  const idx = order.indexOf(current);
  return order[(idx + 1) % order.length];
}

export function formatFramingLabel(config: SerialConfig): string {
  const parityChar = config.parity === 1 ? 'O' : config.parity === 2 ? 'E' : 'N';
  const flowSuffix = config.flowControl === 1 ? ' RTS/CTS' : '';
  return `${config.dataBits}${parityChar}${config.stopBits}${flowSuffix}`;
}
