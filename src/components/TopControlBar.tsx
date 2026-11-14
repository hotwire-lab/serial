import React, { useState } from 'react';
import {
  BAUD_RATES,
  BrowserCapabilities,
  ConnectionStateSnapshot,
  SerialConfig,
  TransportPreference,
} from '../serial/types';
import { ViewMode } from '../buffer/formatters';
import { LineEnding, formatFramingLabel } from '../storage/preferencesStore';

interface TopControlBarProps {
  snapshot: ConnectionStateSnapshot;
  capabilities: BrowserCapabilities;
  serialConfig: SerialConfig;
  transportPreference: TransportPreference;
  viewMode: ViewMode;
  showTimestamps: boolean;
  showInvisibleChars: boolean;
  fontSize: number;
  lineEnding: LineEnding;
  localEcho: boolean;
  onConnect: (override?: 'webserial' | 'webusb') => void;
  onDisconnect: () => void;
  onStartDemo: () => void;
  onSelectPort: (portIndex: number) => void;
  onChangeSerialConfig: (next: SerialConfig) => void;
  onChangeTransportPreference: (pref: TransportPreference) => void;
  onToggleDtr: () => void;
  onToggleRts: () => void;
  onPulseReset: () => void;
  onToggleViewMode: () => void;
  onToggleTimestamps: () => void;
  onToggleInvisibles: () => void;
  onAdjustFontSize: (delta: number) => void;
  onCycleLineEnding: (next: LineEnding) => void;
  onToggleLocalEcho: () => void;
  onExportLog: () => void;
  onClearTerminal: () => void;
}

const FRAMING_PRESETS: Array<{ label: string; dataBits: 7 | 8; parity: 0 | 1 | 2; stopBits: 1 | 2 }> = [
  { label: '8N1', dataBits: 8, parity: 0, stopBits: 1 },
  { label: '8E1', dataBits: 8, parity: 2, stopBits: 1 },
  { label: '8O1', dataBits: 8, parity: 1, stopBits: 1 },
  { label: '7E1', dataBits: 7, parity: 2, stopBits: 1 },
  { label: '8N2', dataBits: 8, parity: 0, stopBits: 2 },
];

const LINE_ENDINGS: LineEnding[] = ['CRLF', 'LF', 'CR', 'RAW'];

export const TopControlBar: React.FC<TopControlBarProps> = ({
  snapshot,
  capabilities,
  serialConfig,
  transportPreference,
  viewMode,
  showTimestamps,
  showInvisibleChars,
  fontSize,
  lineEnding,
  localEcho,
  onConnect,
  onDisconnect,
  onStartDemo,
  onSelectPort,
  onChangeSerialConfig,
  onChangeTransportPreference,
  onToggleDtr,
  onToggleRts,
  onPulseReset,
  onToggleViewMode,
  onToggleTimestamps,
  onToggleInvisibles,
  onAdjustFontSize,
  onCycleLineEnding,
  onToggleLocalEcho,
  onExportLog,
  onClearTerminal,
}) => {
  const [openMenu, setOpenMenu] = useState<'none' | 'baud' | 'settings'>('none');
  const isConnected = snapshot.state === 'CONNECTED';
  const isHandshaking = snapshot.state === 'HANDSHAKING';
  const hasError = Boolean(snapshot.errorMessage);
  const canConnect = capabilities.isSecureContext && capabilities.recommendedTransport !== 'none';

  const dotClass = isConnected
    ? 'status-dot connected'
    : hasError
      ? 'status-dot error'
      : 'status-dot standby';

  let connectButtonLabel = 'Connect USB';
  if (isConnected) {
    connectButtonLabel = snapshot.deviceName ?? 'Connected';
  } else if (isHandshaking) {
    connectButtonLabel = 'Connecting...';
  } else if (!capabilities.isSecureContext) {
    connectButtonLabel = 'HTTPS Required';
  } else if (capabilities.recommendedTransport === 'none') {
    connectButtonLabel = 'No USB API';
  }

  return (
    <header className="top-bar">
      <div className="top-bar-row">
        {/* Left: Unified Connection Pill Button + optional multi-port switcher */}
        <div className="connection-group">
          <button
            type="button"
            className={`connect-pill-btn ${isConnected ? 'is-connected' : ''}`}
            onClick={() => {
              setOpenMenu('none');
              if (isConnected || isHandshaking) {
                onDisconnect();
              } else {
                onConnect();
              }
            }}
            disabled={!isConnected && !isHandshaking && !canConnect}
            title={isConnected ? 'Click to disconnect' : 'Pair and connect USB serial device'}
          >
            <span className={dotClass} />
            <span className="status-text">{connectButtonLabel}</span>
            {isConnected && <span className="disconnect-hint">Disconnect</span>}
          </button>

          {isConnected && snapshot.portCount > 1 && (
            <div className="port-switcher" role="group" aria-label="Serial port switcher">
              {Array.from({ length: snapshot.portCount }, (_, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={`port-btn ${snapshot.portIndex === idx ? 'active' : ''}`}
                  onClick={() => onSelectPort(idx)}
                >
                  P{idx}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right: 3 compact controls (Baud, Clear, Settings) */}
        <div className="controls-group">
          <div className="popover-anchor">
            <button
              type="button"
              className="btn-pill btn-mono"
              onClick={() => setOpenMenu((cur) => (cur === 'baud' ? 'none' : 'baud'))}
              title="Select baud rate"
            >
              {serialConfig.baudRate} ▾
            </button>

            {openMenu === 'baud' && (
              <>
                <div className="popover-backdrop" onClick={() => setOpenMenu('none')} />
                <div className="settings-popover settings-popover--right" role="dialog" aria-label="Baud rate">
                  <div className="popover-section-title">Baud Rate</div>
                  <div className="baud-grid">
                    {BAUD_RATES.map((baud) => (
                      <button
                        key={baud}
                        type="button"
                        className={`baud-chip ${serialConfig.baudRate === baud ? 'active' : ''}`}
                        onClick={() => {
                          onChangeSerialConfig({ ...serialConfig, baudRate: baud });
                          setOpenMenu('none');
                        }}
                      >
                        {baud}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            className="btn-pill"
            onClick={() => {
              setOpenMenu('none');
              onClearTerminal();
            }}
            title="Clear terminal screen and buffer"
          >
            Clear
          </button>

          <div className="popover-anchor">
            <button
              type="button"
              className={`btn-pill btn-icon ${openMenu === 'settings' ? 'active-blue' : ''}`}
              onClick={() => setOpenMenu((cur) => (cur === 'settings' ? 'none' : 'settings'))}
              aria-label="Tools and settings"
              title="Tools & Settings"
            >
              ⚙
            </button>

            {openMenu === 'settings' && (
              <>
                <div className="popover-backdrop" onClick={() => setOpenMenu('none')} />
                <div className="settings-popover settings-popover--right settings-popover--wide" role="dialog" aria-label="Tools and settings">
                  <div className="popover-section-title">View</div>
                  <div className="framing-row">
                    <button
                      type="button"
                      className={`baud-chip ${viewMode === 'HEX' ? 'active' : ''}`}
                      onClick={onToggleViewMode}
                    >
                      Mode: {viewMode}
                    </button>
                    <button
                      type="button"
                      className={`baud-chip ${showTimestamps ? 'active' : ''}`}
                      onClick={onToggleTimestamps}
                    >
                      Timestamps
                    </button>
                    <button
                      type="button"
                      className={`baud-chip ${showInvisibleChars ? 'active' : ''}`}
                      onClick={onToggleInvisibles}
                    >
                      Invisibles (¶)
                    </button>
                    <div className="font-zoom-inline">
                      <button
                        type="button"
                        className="zoom-btn"
                        onClick={() => onAdjustFontSize(-1)}
                        aria-label="Decrease font size"
                      >
                        −
                      </button>
                      <span className="zoom-value">{fontSize}px</span>
                      <button
                        type="button"
                        className="zoom-btn"
                        onClick={() => onAdjustFontSize(1)}
                        aria-label="Increase font size"
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className="popover-section-title">Input</div>
                  <div className="framing-row">
                    {LINE_ENDINGS.map((le) => (
                      <button
                        key={le}
                        type="button"
                        className={`baud-chip ${lineEnding === le ? 'active' : ''}`}
                        onClick={() => onCycleLineEnding(le)}
                      >
                        {le}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={`baud-chip ${localEcho ? 'active' : ''}`}
                      onClick={onToggleLocalEcho}
                    >
                      Echo: {localEcho ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  <div className="popover-section-title">
                    Hardware Signals ({formatFramingLabel(serialConfig)})
                  </div>
                  <div className="framing-row">
                    <button
                      type="button"
                      className={`baud-chip ${snapshot.dtr ? 'active-green-chip' : ''}`}
                      onClick={onToggleDtr}
                      disabled={!isConnected}
                    >
                      DTR
                    </button>
                    <button
                      type="button"
                      className={`baud-chip ${snapshot.rts ? 'active-green-chip' : ''}`}
                      onClick={onToggleRts}
                      disabled={!isConnected}
                    >
                      RTS
                    </button>
                    <button
                      type="button"
                      className="baud-chip"
                      onClick={onPulseReset}
                      disabled={!isConnected}
                    >
                      Reset MCU
                    </button>
                  </div>

                  <div className="framing-row" style={{ marginTop: 6 }}>
                    {FRAMING_PRESETS.map((preset) => {
                      const active =
                        serialConfig.dataBits === preset.dataBits &&
                        serialConfig.parity === preset.parity &&
                        serialConfig.stopBits === preset.stopBits;
                      return (
                        <button
                          key={preset.label}
                          type="button"
                          className={`baud-chip ${active ? 'active' : ''}`}
                          onClick={() =>
                            onChangeSerialConfig({
                              ...serialConfig,
                              dataBits: preset.dataBits,
                              parity: preset.parity,
                              stopBits: preset.stopBits,
                            })
                          }
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className={`baud-chip ${serialConfig.flowControl === 1 ? 'active' : ''}`}
                      onClick={() =>
                        onChangeSerialConfig({
                          ...serialConfig,
                          flowControl: serialConfig.flowControl === 1 ? 0 : 1,
                        })
                      }
                    >
                      RTS/CTS
                    </button>
                  </div>

                  <div className="framing-row" style={{ marginTop: 6 }}>
                    {(
                      [
                        { id: 'auto', label: 'Auto' },
                        { id: 'webserial', label: 'Web Serial', ok: capabilities.hasWebSerial },
                        { id: 'webusb', label: 'WebUSB', ok: capabilities.hasWebUSB },
                      ] as Array<{ id: TransportPreference; label: string; ok?: boolean }>
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        disabled={opt.ok === false}
                        className={`baud-chip ${transportPreference === opt.id ? 'active' : ''}`}
                        onClick={() => onChangeTransportPreference(opt.id)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  <div className="popover-section-title">Session</div>
                  <div className="framing-row">
                    <button
                      type="button"
                      className="baud-chip"
                      onClick={() => {
                        setOpenMenu('none');
                        onExportLog();
                      }}
                    >
                      Export Log
                    </button>
                    {!isConnected && !isHandshaking && (
                      <button
                        type="button"
                        className="baud-chip"
                        onClick={() => {
                          setOpenMenu('none');
                          onStartDemo();
                        }}
                      >
                        Start Demo
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
