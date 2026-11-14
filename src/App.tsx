import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RingBuffer } from './buffer/RingBuffer';
import {
  LineState,
  ViewOptions,
  encodeUtf8,
  exportRingBufferToLog,
  formatConnectedSeparator,
  formatDisconnectedSeparator,
  formatEntryForTerminal,
  replayEntriesToString,
} from './buffer/formatters';
import { BottomCommandBar } from './components/BottomCommandBar';
import { MacroEditModal } from './components/MacroEditModal';
import { TerminalViewport, TerminalViewportHandle } from './components/TerminalViewport';
import { TopControlBar } from './components/TopControlBar';
import { detectBrowserCapabilities, serialManager } from './serial/SerialManager';
import {
  BrowserCapabilities,
  ConnectionStateSnapshot,
  INITIAL_CONNECTION_SNAPSHOT,
  SerialConfig,
  TransportPreference,
} from './serial/types';
import {
  HotWirePreferences,
  LineEnding,
  MacroItem,
  lineEndingToBytes,
  loadPreferences,
  savePreferences,
} from './storage/preferencesStore';

export const App: React.FC = () => {
  const [prefs, setPrefs] = useState<HotWirePreferences>(() => loadPreferences());
  const [snapshot, setSnapshot] = useState<ConnectionStateSnapshot>(() => ({
    ...INITIAL_CONNECTION_SNAPSHOT,
    baudRate: prefs.baudRate,
  }));
  const [capabilities, setCapabilities] = useState<BrowserCapabilities>(() =>
    detectBrowserCapabilities()
  );
  const [editingMacro, setEditingMacro] = useState<MacroItem | null>(null);
  const [isAutoScrollLocked, setIsAutoScrollLocked] = useState(false);
  const [unseenChunks, setUnseenChunks] = useState(0);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [viewportStyle, setViewportStyle] = useState<React.CSSProperties | undefined>(undefined);

  const ringBufferRef = useRef<RingBuffer>(new RingBuffer());
  const terminalRef = useRef<TerminalViewportHandle | null>(null);
  const lineStateRef = useRef<LineState>({ atLineStart: true });
  const prefsRef = useRef<HotWirePreferences>(prefs);
  const prevStateRef = useRef<ConnectionStateSnapshot>(snapshot);
  const autoScrollLockedRef = useRef<boolean>(false);

  prefsRef.current = prefs;
  autoScrollLockedRef.current = isAutoScrollLocked;

  const serialConfig: SerialConfig = {
    baudRate: prefs.baudRate,
    dataBits: prefs.dataBits,
    stopBits: prefs.stopBits,
    parity: prefs.parity,
    flowControl: prefs.flowControl,
  };

  const updatePrefs = useCallback(
    (updater: (current: HotWirePreferences) => HotWirePreferences) => {
      setPrefs((current) => {
        const next = updater(current);
        prefsRef.current = next;
        savePreferences(next);
        return next;
      });
    },
    []
  );

  // Mobile visualViewport sizing so virtual keyboards push the bottom bar smoothly
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const syncViewport = () => {
      setViewportStyle({
        height: `${vv.height}px`,
        transform: vv.offsetTop > 0 ? `translateY(${vv.offsetTop}px)` : undefined,
      });
    };

    syncViewport();
    vv.addEventListener('resize', syncViewport);
    vv.addEventListener('scroll', syncViewport);
    return () => {
      vv.removeEventListener('resize', syncViewport);
      vv.removeEventListener('scroll', syncViewport);
    };
  }, []);

  // Re-evaluate browser capabilities & wire SerialManager lifecycle
  useEffect(() => {
    setCapabilities(detectBrowserCapabilities());
    serialManager.setDeviceProfiles(prefsRef.current.deviceProfiles);
    serialManager.setTransportPreference(prefsRef.current.transportPreference);
    void serialManager.configureSerial({
      baudRate: prefsRef.current.baudRate,
      dataBits: prefsRef.current.dataBits,
      stopBits: prefsRef.current.stopBits,
      parity: prefsRef.current.parity,
      flowControl: prefsRef.current.flowControl,
    });

    const unsubState = serialManager.onStateChange((next) => {
      const prev = prevStateRef.current;
      prevStateRef.current = next;
      setSnapshot(next);
      if (next.errorMessage) {
        setDismissedError(null);
      }

      if (next.state === 'CONNECTED' && prev.state !== 'CONNECTED') {
        const label = next.deviceName ?? next.chipType ?? 'USB Serial';
        const sep = formatConnectedSeparator(label, next.portIndex, Date.now());
        const entry = ringBufferRef.current.push({
          timestamp: Date.now(),
          data: encodeUtf8(sep),
          type: 'SYSTEM_EVENT',
          systemText: sep,
        });
        const formatted = formatEntryForTerminal(
          entry,
          {
            viewMode: prefsRef.current.viewMode,
            showTimestamps: prefsRef.current.showTimestamps,
            showInvisibleChars: prefsRef.current.showInvisibleChars,
          },
          lineStateRef.current
        );
        terminalRef.current?.write(formatted);
      } else if (next.state === 'DISCONNECTED' && prev.state === 'CONNECTED') {
        const sep = formatDisconnectedSeparator(Date.now());
        const entry = ringBufferRef.current.push({
          timestamp: Date.now(),
          data: encodeUtf8(sep),
          type: 'SYSTEM_EVENT',
          systemText: sep,
        });
        const formatted = formatEntryForTerminal(
          entry,
          {
            viewMode: prefsRef.current.viewMode,
            showTimestamps: prefsRef.current.showTimestamps,
            showInvisibleChars: prefsRef.current.showInvisibleChars,
          },
          lineStateRef.current
        );
        terminalRef.current?.write(formatted);
      }
    });

    const unsubData = serialManager.onData((bytes) => {
      const entry = ringBufferRef.current.push({
        timestamp: Date.now(),
        data: bytes,
        type: 'RX',
      });
      const formatted = formatEntryForTerminal(
        entry,
        {
          viewMode: prefsRef.current.viewMode,
          showTimestamps: prefsRef.current.showTimestamps,
          showInvisibleChars: prefsRef.current.showInvisibleChars,
        },
        lineStateRef.current
      );
      if (formatted) {
        terminalRef.current?.write(formatted);
        if (autoScrollLockedRef.current) {
          setUnseenChunks((c) => c + 1);
        }
      }
    });

    serialManager.init();

    return () => {
      unsubState();
      unsubData();
      serialManager.destroy();
    };
  }, []);

  const replayRingBufferWithOptions = useCallback((nextView: ViewOptions) => {
    terminalRef.current?.clear();
    lineStateRef.current = { atLineStart: true };
    const entries = ringBufferRef.current.getAll();
    if (entries.length === 0) return;

    const lineState: LineState = { atLineStart: true };
    const chunkSize = 250;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const slice = entries.slice(i, i + chunkSize);
      let chunkStr = '';
      for (const entry of slice) {
        chunkStr += formatEntryForTerminal(entry, nextView, lineState);
      }
      if (chunkStr) {
        terminalRef.current?.write(chunkStr);
      }
    }
    lineStateRef.current = lineState;
  }, []);

  const appendLocalEcho = useCallback((bytes: Uint8Array) => {
    const entry = ringBufferRef.current.push({
      timestamp: Date.now(),
      data: bytes,
      type: 'TX',
    });
    const formatted = formatEntryForTerminal(
      entry,
      {
        viewMode: prefsRef.current.viewMode,
        showTimestamps: prefsRef.current.showTimestamps,
        showInvisibleChars: prefsRef.current.showInvisibleChars,
      },
      lineStateRef.current
    );
    if (formatted) {
      terminalRef.current?.write(formatted);
    }
  }, []);

  const handleSendText = useCallback(
    async (text: string, ending: LineEnding) => {
      const fullPayload = `${text}${lineEndingToBytes(ending)}`;
      const bytes = encodeUtf8(fullPayload);
      if (bytes.byteLength === 0) return;

      if (prefsRef.current.localEcho) {
        appendLocalEcho(bytes);
      }
      await serialManager.writeBytes(bytes);
    },
    [appendLocalEcho]
  );

  const handleSendRawControl = useCallback(async (sequence: string) => {
    const bytes = encodeUtf8(sequence);
    await serialManager.writeBytes(bytes);
  }, []);

  const handleTerminalInput = useCallback(async (data: string) => {
    if (serialManager.getSnapshot().state !== 'CONNECTED') return;
    await serialManager.writeBytes(encodeUtf8(data));
  }, []);

  const handleChangeSerialConfig = useCallback(
    (next: SerialConfig) => {
      updatePrefs((cur) => ({ ...cur, ...next }));
      void serialManager.configureSerial(next);
    },
    [updatePrefs]
  );

  const handleChangeTransportPreference = useCallback(
    (pref: TransportPreference) => {
      serialManager.setTransportPreference(pref);
      updatePrefs((cur) => ({ ...cur, transportPreference: pref }));
    },
    [updatePrefs]
  );

  const persistDeviceProfile = useCallback(
    (dtr: boolean, rts: boolean, portIndex: number) => {
      const vidPid = snapshot.vidPid;
      if (!vidPid) return;
      const updatedProfiles = {
        ...prefsRef.current.deviceProfiles,
        [vidPid]: { dtr, rts, portIndex },
      };
      serialManager.setDeviceProfiles(updatedProfiles);
      updatePrefs((cur) => ({ ...cur, deviceProfiles: updatedProfiles }));
    },
    [snapshot.vidPid, updatePrefs]
  );

  const handleToggleDtr = useCallback(() => {
    const nextDtr = !snapshot.dtr;
    persistDeviceProfile(nextDtr, snapshot.rts, snapshot.portIndex);
    void serialManager.setControlLines(nextDtr, snapshot.rts);
  }, [persistDeviceProfile, snapshot.dtr, snapshot.portIndex, snapshot.rts]);

  const handleToggleRts = useCallback(() => {
    const nextRts = !snapshot.rts;
    persistDeviceProfile(snapshot.dtr, nextRts, snapshot.portIndex);
    void serialManager.setControlLines(snapshot.dtr, nextRts);
  }, [persistDeviceProfile, snapshot.dtr, snapshot.portIndex, snapshot.rts]);

  const handleSelectPort = useCallback(
    (portIndex: number) => {
      persistDeviceProfile(snapshot.dtr, snapshot.rts, portIndex);
      void serialManager.selectPort(portIndex);
    },
    [persistDeviceProfile, snapshot.dtr, snapshot.rts]
  );

  const handleToggleViewMode = useCallback(() => {
    const nextMode = prefsRef.current.viewMode === 'ASCII' ? 'HEX' : 'ASCII';
    const nextView: ViewOptions = {
      viewMode: nextMode,
      showTimestamps: prefsRef.current.showTimestamps,
      showInvisibleChars: prefsRef.current.showInvisibleChars,
    };
    updatePrefs((cur) => ({ ...cur, viewMode: nextMode }));
    replayRingBufferWithOptions(nextView);
  }, [replayRingBufferWithOptions, updatePrefs]);

  const handleToggleTimestamps = useCallback(() => {
    const nextTs = !prefsRef.current.showTimestamps;
    const nextView: ViewOptions = {
      viewMode: prefsRef.current.viewMode,
      showTimestamps: nextTs,
      showInvisibleChars: prefsRef.current.showInvisibleChars,
    };
    updatePrefs((cur) => ({ ...cur, showTimestamps: nextTs }));
    replayRingBufferWithOptions(nextView);
  }, [replayRingBufferWithOptions, updatePrefs]);

  const handleToggleInvisibles = useCallback(() => {
    const nextInv = !prefsRef.current.showInvisibleChars;
    const nextView: ViewOptions = {
      viewMode: prefsRef.current.viewMode,
      showTimestamps: prefsRef.current.showTimestamps,
      showInvisibleChars: nextInv,
    };
    updatePrefs((cur) => ({ ...cur, showInvisibleChars: nextInv }));
    replayRingBufferWithOptions(nextView);
  }, [replayRingBufferWithOptions, updatePrefs]);

  const handleFontSizeChange = useCallback(
    (nextSize: number) => {
      updatePrefs((cur) => ({ ...cur, fontSize: nextSize }));
    },
    [updatePrefs]
  );

  const handleAdjustFontSize = useCallback(
    (delta: number) => {
      const clamped = Math.max(9, Math.min(24, prefsRef.current.fontSize + delta));
      terminalRef.current?.setFontSize(clamped);
    },
    []
  );

  const handleExportLog = useCallback(async () => {
    const entries = ringBufferRef.current.getAll();
    const content =
      entries.length > 0
        ? exportRingBufferToLog(entries, {
            viewMode: prefsRef.current.viewMode,
            showTimestamps: prefsRef.current.showTimestamps,
            showInvisibleChars: prefsRef.current.showInvisibleChars,
          })
        : replayEntriesToString([], {
            viewMode: 'ASCII',
            showTimestamps: false,
            showInvisibleChars: false,
          });

    const tsSlug = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `hotwire-${tsSlug}.log`;

    if (typeof navigator !== 'undefined' && navigator.share && typeof File !== 'undefined') {
      try {
        const file = new File([content], filename, { type: 'text/plain' });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return;
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
      }
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, []);

  const handleClearTerminal = useCallback(() => {
    ringBufferRef.current.clear();
    lineStateRef.current = { atLineStart: true };
    setUnseenChunks(0);
    setIsAutoScrollLocked(false);
    terminalRef.current?.clear();
  }, []);

  const handleSaveMacro = useCallback(
    (updated: MacroItem) => {
      updatePrefs((cur) => ({
        ...cur,
        macros: cur.macros.map((m) => (m.id === updated.id ? updated : m)),
      }));
      setEditingMacro(null);
    },
    [updatePrefs]
  );

  const visibleError =
    snapshot.errorMessage && snapshot.errorMessage !== dismissedError
      ? snapshot.errorMessage
      : null;

  return (
    <div className="app-shell" style={viewportStyle}>
      <TopControlBar
        snapshot={snapshot}
        capabilities={capabilities}
        serialConfig={serialConfig}
        transportPreference={prefs.transportPreference}
        viewMode={prefs.viewMode}
        showTimestamps={prefs.showTimestamps}
        showInvisibleChars={prefs.showInvisibleChars}
        fontSize={prefs.fontSize}
        lineEnding={prefs.lineEnding}
        localEcho={prefs.localEcho}
        onConnect={(override) => {
          void serialManager.connectWithPicker(override);
        }}
        onDisconnect={() => {
          void serialManager.disconnect(true);
        }}
        onStartDemo={() => {
          void serialManager.startDemo();
        }}
        onSelectPort={handleSelectPort}
        onChangeSerialConfig={handleChangeSerialConfig}
        onChangeTransportPreference={handleChangeTransportPreference}
        onToggleDtr={handleToggleDtr}
        onToggleRts={handleToggleRts}
        onPulseReset={() => {
          void serialManager.pulseReset();
        }}
        onToggleViewMode={handleToggleViewMode}
        onToggleTimestamps={handleToggleTimestamps}
        onToggleInvisibles={handleToggleInvisibles}
        onAdjustFontSize={handleAdjustFontSize}
        onCycleLineEnding={(next) => updatePrefs((cur) => ({ ...cur, lineEnding: next }))}
        onToggleLocalEcho={() => updatePrefs((cur) => ({ ...cur, localEcho: !cur.localEcho }))}
        onExportLog={() => {
          void handleExportLog();
        }}
        onClearTerminal={handleClearTerminal}
      />

      {visibleError && (
        <div className="notice-banner" role="status">
          <span className="notice-text">{visibleError}</span>
          <button
            type="button"
            className="notice-close"
            onClick={() => setDismissedError(visibleError)}
            aria-label="Dismiss message"
          >
            ✕
          </button>
        </div>
      )}

      <main className="main-area">
        <TerminalViewport
          ref={terminalRef}
          initialFontSize={prefs.fontSize}
          onFontSizeChange={handleFontSizeChange}
          onTerminalInput={handleTerminalInput}
          unseenChunks={unseenChunks}
          onResetUnseenChunks={() => setUnseenChunks(0)}
          isAutoScrollLocked={isAutoScrollLocked}
          onAutoScrollLockChange={setIsAutoScrollLocked}
        />
      </main>

      <BottomCommandBar
        isConnected={snapshot.state === 'CONNECTED'}
        macros={prefs.macros}
        lineEnding={prefs.lineEnding}
        onSendText={handleSendText}
        onSendRawControl={handleSendRawControl}
        onEditMacro={setEditingMacro}
      />

      <MacroEditModal
        macro={editingMacro}
        onClose={() => setEditingMacro(null)}
        onSave={handleSaveMacro}
      />
    </div>
  );
};

export default App;
