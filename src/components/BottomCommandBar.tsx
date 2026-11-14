import React, { useRef, useState } from 'react';
import { LineEnding, MacroItem, nextLineEnding } from '../storage/preferencesStore';

interface BottomCommandBarProps {
  isConnected: boolean;
  macros: MacroItem[];
  lineEnding: LineEnding;
  localEcho: boolean;
  onSendText: (text: string, lineEnding: LineEnding) => void;
  onSendRawControl: (sequence: string) => void;
  onCycleLineEnding: (next: LineEnding) => void;
  onToggleLocalEcho: () => void;
  onEditMacro: (macro: MacroItem) => void;
}

const SHELL_KEYS = [
  { label: 'TAB', seq: '\t', title: 'Tab autocomplete (\\t)' },
  { label: '↑', seq: '\x1b[A', title: 'History Up (ESC [ A)' },
  { label: '↓', seq: '\x1b[B', title: 'History Down (ESC [ B)' },
  { label: 'Ctrl+C', seq: '\x03', title: 'Interrupt (ETX 0x03)' },
  { label: 'ESC', seq: '\x1b', title: 'Escape (0x1B)' },
] as const;

export const BottomCommandBar: React.FC<BottomCommandBarProps> = ({
  isConnected,
  macros,
  lineEnding,
  localEcho,
  onSendText,
  onSendRawControl,
  onCycleLineEnding,
  onToggleLocalEcho,
  onEditMacro,
}) => {
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

  const handleSubmit = () => {
    const trimmed = command;
    onSendText(trimmed, lineEnding);
    if (trimmed.length > 0) {
      setHistory((prev) => (prev[0] === trimmed ? prev : [trimmed, ...prev.slice(0, 49)]));
    }
    setHistoryIndex(-1);
    setCommand('');
    inputRef.current?.focus();
  };

  const handleInputKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      handleSubmit();
    } else if (ev.key === 'ArrowUp') {
      if (history.length > 0) {
        ev.preventDefault();
        const nextIdx = Math.min(history.length - 1, historyIndex + 1);
        setHistoryIndex(nextIdx);
        setCommand(history[nextIdx]);
      }
    } else if (ev.key === 'ArrowDown') {
      if (historyIndex >= 0) {
        ev.preventDefault();
        const nextIdx = historyIndex - 1;
        setHistoryIndex(nextIdx);
        setCommand(nextIdx >= 0 ? history[nextIdx] : '');
      }
    }
  };

  const startMacroLongPress = (macro: MacroItem) => {
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      onEditMacro(macro);
    }, 450);
  };

  const cancelMacroLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  return (
    <footer className="bottom-bar">
      {/* Horizontal Quick Control & User Macros Row */}
      <div className="macro-scroll-row" role="toolbar" aria-label="Shell keys and macros">
        {SHELL_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="shell-chip"
            title={key.title}
            disabled={!isConnected}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onSendRawControl(key.seq)}
          >
            {key.label}
          </button>
        ))}

        <span className="toolbar-divider" aria-hidden="true" />

        {macros.map((macro) => (
          <button
            key={macro.id}
            type="button"
            className="macro-chip"
            title={`${macro.payload} (${macro.lineEnding}) — Long-press or right-click to edit`}
            disabled={!isConnected}
            onMouseDown={(ev) => ev.preventDefault()}
            onTouchStart={() => startMacroLongPress(macro)}
            onTouchEnd={cancelMacroLongPress}
            onTouchMove={cancelMacroLongPress}
            onContextMenu={(ev) => {
              ev.preventDefault();
              onEditMacro(macro);
            }}
            onClick={() => {
              if (longPressTriggeredRef.current) {
                longPressTriggeredRef.current = false;
                return;
              }
              onSendText(macro.payload, macro.lineEnding);
            }}
          >
            {macro.label}
          </button>
        ))}
      </div>

      {/* Command Input Row */}
      <div className="command-row">
        <input
          ref={inputRef}
          type="text"
          className="command-input"
          value={command}
          onChange={(ev) => setCommand(ev.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={isConnected ? 'Type command…' : 'Connect USB or Demo to send'}
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          aria-label="Serial command input"
        />

        <button
          type="button"
          className="btn-pill btn-mono"
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => onCycleLineEnding(nextLineEnding(lineEnding))}
          title="Cycle line ending: CRLF -> LF -> CR -> RAW"
        >
          {lineEnding}
        </button>

        <button
          type="button"
          className={`btn-pill ${localEcho ? 'active-blue' : ''}`}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={onToggleLocalEcho}
          title="Toggle Local Echo"
        >
          Echo
        </button>

        <button
          type="button"
          className="btn-send"
          disabled={!isConnected}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={handleSubmit}
        >
          Send
        </button>
      </div>
    </footer>
  );
};
