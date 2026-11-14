import React, { useState } from 'react';
import {
  BAUD_RATES,
  BrowserCapabilities,
  ConnectionStateSnapshot,
  SerialConfig,
  TransportPreference,
} from '../serial/types';
import { ViewMode } from '../buffer/formatters';
import { formatFramingLabel } from '../storage/preferencesStore';

interface TopControlBarProps {
  snapshot: ConnectionStateSnapshot;
  capabilities: BrowserCapabilities;
  serialConfig: SerialConfig;
  transportPreference: TransportPreference;
  viewMode: ViewMode;
  showTimestamps: boolean;
  showInvisibleChars: boolean;
  fontSize: number;
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

export const TopControlBar: React.FC<TopControlBarProps> = ({
  snapshot,
  capabilities,
  serialConfig,
  transportPreference,
  viewMode,
  showTimestamps,
  showInvisibleChars,
  fontSize,
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
  onExportLog,
  onClearTerminal,
}) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const isConnected = snapshot.state === 'CONNECTED';
  const isHandshaking = snapshot.state === 'HANDSHAKING';
  const hasError = Boolean(snapshot.errorMessage);

  const dotClass = isConnected
    ? 'status-dot connected'
    : hasError
      ? 'status-dot error'
      : 'status-dot standby';

  let statusLabel = 'Standby';
  if (isConnected) {
    statusLabel = snapshot.deviceName ?? 'USB Connected';
  } else if (isHandshaking) {
    statusLabel = `Connecting${snapshot.deviceName ? ` • ${snapshot.deviceName}` : ''}...`;
  } else if (!capabilities.isSecureContext) {
    statusLabel = 'HTTPS Required';
  } else if (capabilities.recommendedTransport === 'none') {
    statusLabel = 'No Browser USB API';
  }

  return (
    <header className="top-bar">
      <div className="top-bar-row">
        {/* Connection Status & Connect/Disconnect Action */}
        <div className="connection-group">
          <div className="status-pill" title={snapshot.vidPid ?? statusLabel}>
            <span className={dotClass} />
            <span className="status-text">{statusLabel}</span>
            {isConnected && snapshot.chipType && (
              <span className="chip-tag">{snapshot.chipType}</span>
            )}
          </div>

          {!isConnected && !isHandshaking ? (
            <>
              <button
                type="button"
                className="btn-primary-connect"
                onClick={() => onConnect()}
                disabled={!capabilities.isSecureContext || capabilities.recommendedTransport === 'none'}
                title="Pair and open USB serial device"
              >
                Connect USB
              </button>
              <button
                type="button"
                className="btn-pill"
                onClick={onStartDemo}
                title="Launch simulated ESP32-S3 shell"
              >
                Demo
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-danger-disconnect"
              onClick={onDisconnect}
              title="Disconnect serial session"
            >
              Disconnect
            </button>
          )}

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

        {/* Serial Params, Control Lines, View Toggles & Actions */}
        <div className="controls-group">
          <div className="baud-popover-anchor">
            <button
              type="button"
              className="btn-pill btn-mono"
              onClick={() => setSettingsOpen((prev) => !prev)}
              title="Configure baud rate, framing & transport"
            >
              {serialConfig.baudRate} <span className="muted-sub">{formatFramingLabel(serialConfig)}</span> ▾
            </button>

            {settingsOpen && (
              <>
                <div className="popover-backdrop" onClick={() => setSettingsOpen(false)} />
                <div className="settings-popover" role="dialog" aria-label="Serial configuration">
                  <div className="popover-section-title">Baud Rate</div>
                  <div className="baud-grid">
                    {BAUD_RATES.map((baud) => (
                      <button
                        key={baud}
                        type="button"
                        className={`baud-chip ${serialConfig.baudRate === baud ? 'active' : ''}`}
                        onClick={() => {
                          onChangeSerialConfig({ ...serialConfig, baudRate: baud });
                          setSettingsOpen(false);
                        }}
                      >
                        {baud}
                      </button>
                    ))}
                  </div>

                  <div className="popover-section-title">Framing & Flow Control</div>
                  <div className="framing-row">
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

                  <div className="popover-section-title">Browser USB Transport</div>
                  <div className="framing-row">
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
                </div>
              </>
            )}
          </div>

          <button
            type="button"
            className={`btn-pill btn-mono ${snapshot.dtr ? 'active-green' : ''}`}
            onClick={onToggleDtr}
            disabled={!isConnected}
            title="Toggle DTR (Data Terminal Ready)"
          >
            DTR
          </button>
          <button
            type="button"
            className={`btn-pill btn-mono ${snapshot.rts ? 'active-green' : ''}`}
            onClick={onToggleRts}
            disabled={!isConnected}
            title="Toggle RTS (Request To Send)"
          >
            RTS
          </button>
          <button
            type="button"
            className="btn-pill btn-mono btn-warn"
            onClick={onPulseReset}
            disabled={!isConnected}
            title="100ms DTR/RTS reset pulse"
          >
            RST
          </button>

          <span className="toolbar-divider" aria-hidden="true" />

          <button
            type="button"
            className={`btn-pill btn-mono ${viewMode === 'HEX' ? 'active-blue' : ''}`}
            onClick={onToggleViewMode}
            title="Toggle ASCII / HEX view"
          >
            {viewMode}
          </button>
          <button
            type="button"
            className={`btn-pill ${showTimestamps ? 'active-blue' : ''}`}
            onClick={onToggleTimestamps}
            title="Toggle line timestamps"
          >
            TS
          </button>
          <button
            type="button"
            className={`btn-pill btn-mono ${showInvisibleChars ? 'active-blue' : ''}`}
            onClick={onToggleInvisibles}
            title="Show invisible control characters (CR, LF, NUL)"
          >
            ¶
          </button>

          <div className="font-zoom-group" title="Terminal font size (or pinch / Ctrl+Wheel)">
            <button
              type="button"
              className="zoom-btn"
              onClick={() => onAdjustFontSize(-1)}
              aria-label="Decrease font size"
            >
              −
            </button>
            <span className="zoom-value">{fontSize}</span>
            <button
              type="button"
              className="zoom-btn"
              onClick={() => onAdjustFontSize(1)}
              aria-label="Increase font size"
            >
              +
            </button>
          </div>

          <button
            type="button"
            className="btn-pill"
            onClick={onExportLog}
            title="Export or share terminal log"
          >
            Export
          </button>
          <button
            type="button"
            className="btn-pill"
            onClick={onClearTerminal}
            title="Clear terminal screen and buffer"
          >
            Clear
          </button>
        </div>
      </div>
    </header>
  );
};
