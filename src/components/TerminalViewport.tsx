import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';

export interface TerminalViewportHandle {
  write: (text: string) => void;
  clear: () => void;
  setFontSize: (fontSize: number) => void;
  focus: () => void;
}

interface TerminalViewportProps {
  initialFontSize: number;
  onFontSizeChange: (fontSize: number) => void;
  onTerminalInput?: (data: string) => void;
  unseenChunks: number;
  onResetUnseenChunks: () => void;
  isAutoScrollLocked: boolean;
  onAutoScrollLockChange: (locked: boolean) => void;
}

export const TerminalViewport = React.forwardRef<TerminalViewportHandle, TerminalViewportProps>(
  function TerminalViewport(
    {
      initialFontSize,
      onFontSizeChange,
      onTerminalInput,
      unseenChunks,
      onResetUnseenChunks,
      isAutoScrollLocked,
      onAutoScrollLockChange,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const fontSizeRef = useRef<number>(initialFontSize);
    const lockedRef = useRef<boolean>(isAutoScrollLocked);
    const onFontSizeChangeRef = useRef(onFontSizeChange);
    const onTerminalInputRef = useRef(onTerminalInput);
    const onAutoScrollLockChangeRef = useRef(onAutoScrollLockChange);
    const onResetUnseenChunksRef = useRef(onResetUnseenChunks);

    const pinchStateRef = useRef<{ initialDist: number; startFontSize: number } | null>(null);
    const [dimensions, setDimensions] = useState<{ cols: number; rows: number }>({
      cols: 80,
      rows: 24,
    });

    lockedRef.current = isAutoScrollLocked;
    onFontSizeChangeRef.current = onFontSizeChange;
    onTerminalInputRef.current = onTerminalInput;
    onAutoScrollLockChangeRef.current = onAutoScrollLockChange;
    onResetUnseenChunksRef.current = onResetUnseenChunks;

    const applyFontSize = (nextRaw: number) => {
      const clamped = Math.max(9, Math.min(24, Math.round(nextRaw)));
      if (clamped === fontSizeRef.current) return;
      fontSizeRef.current = clamped;
      const term = termRef.current;
      const fit = fitAddonRef.current;
      if (term) {
        term.options.fontSize = clamped;
        fit?.fit();
        setDimensions({ cols: term.cols, rows: term.rows });
      }
      onFontSizeChangeRef.current(clamped);
    };

    useImperativeHandle(ref, () => ({
      write: (text: string) => {
        const term = termRef.current;
        if (!term || !text) return;
        term.write(text, () => {
          if (!lockedRef.current) {
            term.scrollToBottom();
          }
        });
      },
      clear: () => {
        const term = termRef.current;
        if (!term) return;
        term.reset();
        lockedRef.current = false;
        onAutoScrollLockChangeRef.current(false);
        onResetUnseenChunksRef.current();
      },
      setFontSize: (next: number) => {
        applyFontSize(next);
      },
      focus: () => {
        termRef.current?.focus();
      },
    }));

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const term = new Terminal({
        convertEol: false,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        fontSize: fontSizeRef.current,
        fontFamily:
          "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        allowProposedApi: true,
        theme: {
          background: '#0D1117',
          foreground: '#E6EDF3',
          cursor: '#58A6FF',
          cursorAccent: '#0D1117',
          selectionBackground: 'rgba(88, 166, 255, 0.28)',
          black: '#484F58',
          red: '#FF7B72',
          green: '#3FB950',
          yellow: '#D29922',
          blue: '#58A6FF',
          magenta: '#BC8CFF',
          cyan: '#39C5CF',
          white: '#B1BAC4',
          brightBlack: '#6E7681',
          brightRed: '#FFA198',
          brightGreen: '#56D364',
          brightYellow: '#E3B341',
          brightBlue: '#79C0FF',
          brightMagenta: '#D2A8FF',
          brightCyan: '#56D4DD',
          brightWhite: '#F0F6FC',
        },
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(el);

      try {
        const canvasAddon = new CanvasAddon();
        term.loadAddon(canvasAddon);
      } catch {
        // Fallback cleanly to default DOM renderer when canvas addon is unsupported
      }

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      const fitSafely = () => {
        try {
          fitAddon.fit();
          setDimensions({ cols: term.cols, rows: term.rows });
        } catch {
          // Ignore transient zero-size measurements
        }
      };

      fitSafely();
      const rafId = window.requestAnimationFrame(fitSafely);

      const dataSub = term.onData((data) => {
        onTerminalInputRef.current?.(data);
      });

      const scrollSub = term.onScroll(() => {
        const buf = term.buffer.active;
        const atBottom = buf.viewportY >= buf.baseY - 1;
        if (atBottom && lockedRef.current) {
          lockedRef.current = false;
          onAutoScrollLockChangeRef.current(false);
          onResetUnseenChunksRef.current();
        } else if (!atBottom && !lockedRef.current && buf.baseY > 0) {
          lockedRef.current = true;
          onAutoScrollLockChangeRef.current(true);
        }
      });

      const resizeObserver = new ResizeObserver(() => {
        fitSafely();
      });
      resizeObserver.observe(el);

      const handleWheel = (ev: WheelEvent) => {
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          const delta = ev.deltaY < 0 ? 1 : -1;
          applyFontSize(fontSizeRef.current + delta);
        }
      };

      const touchDist = (t1: Touch, t2: Touch) =>
        Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

      const handleTouchStart = (ev: TouchEvent) => {
        if (ev.touches.length === 2) {
          pinchStateRef.current = {
            initialDist: touchDist(ev.touches[0], ev.touches[1]),
            startFontSize: fontSizeRef.current,
          };
        }
      };

      const handleTouchMove = (ev: TouchEvent) => {
        if (ev.touches.length === 2 && pinchStateRef.current) {
          ev.preventDefault();
          const curDist = touchDist(ev.touches[0], ev.touches[1]);
          if (pinchStateRef.current.initialDist > 10) {
            const scale = curDist / pinchStateRef.current.initialDist;
            applyFontSize(pinchStateRef.current.startFontSize * scale);
          }
        }
      };

      const handleTouchEnd = (ev: TouchEvent) => {
        if (ev.touches.length < 2) {
          pinchStateRef.current = null;
        }
      };

      el.addEventListener('wheel', handleWheel, { passive: false });
      el.addEventListener('touchstart', handleTouchStart, { passive: true });
      el.addEventListener('touchmove', handleTouchMove, { passive: false });
      el.addEventListener('touchend', handleTouchEnd, { passive: true });

      return () => {
        window.cancelAnimationFrame(rafId);
        resizeObserver.disconnect();
        dataSub.dispose();
        scrollSub.dispose();
        el.removeEventListener('wheel', handleWheel);
        el.removeEventListener('touchstart', handleTouchStart);
        el.removeEventListener('touchmove', handleTouchMove);
        el.removeEventListener('touchend', handleTouchEnd);
        term.dispose();
        termRef.current = null;
        fitAddonRef.current = null;
      };
    }, []);

    useEffect(() => {
      if (initialFontSize !== fontSizeRef.current) {
        applyFontSize(initialFontSize);
      }
    }, [initialFontSize]);

    const handleResumeClick = () => {
      const term = termRef.current;
      lockedRef.current = false;
      onAutoScrollLockChange(false);
      onResetUnseenChunks();
      term?.scrollToBottom();
    };

    return (
      <div className="terminal-wrapper">
        <div ref={containerRef} className="terminal-host" />
        <div className="terminal-meta-badge" aria-hidden="true">
          {dimensions.cols}×{dimensions.rows}
        </div>
        {isAutoScrollLocked && (
          <button
            type="button"
            className="resume-scroll-pill"
            onClick={handleResumeClick}
          >
            ↓ Resume{unseenChunks > 0 ? ` (${unseenChunks} new)` : ''}
          </button>
        )}
      </div>
    );
  }
);
