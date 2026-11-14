# HotWire PWA — Cross-Platform USB Serial Terminal

A zero-install, offline-capable Progressive Web App (PWA) USB Serial Terminal built with Vite, React, TypeScript, and `@xterm/xterm` for both **Desktop PCs** and **Android mobile devices**.

**Live Web App (HTTPS):** https://kavierim.github.io/HotWire-PWA/

## Transport Support
* **Desktop (Chrome, Edge, Brave on Windows / macOS / Linux / ChromeOS):**
  * Uses **Web Serial API** (`navigator.serial`) by default for native OS serial drivers, with optional **WebUSB** (`navigator.usb`) fallback.
* **Mobile (Chrome / Edge on Android 8+):**
  * Automatically uses **WebUSB API** (`navigator.usb`) with built-in user-space TypeScript protocol drivers (`CDC-ACM`, `FTDI`, `Silicon Labs CP210x`, `QinHeng CH340/CH341/CH9102`, `Prolific PL2303`).
* **Demo Mode:**
  * Simulated `ESP32-S3 Demo` firmware shell works offline on any browser (including devices without USB hardware).

## Key Features
* **Authorized Auto-Reconnect & Smart Defaults:** Reconnects previously granted USB devices via `getPorts()` / `getDevices()`, applies per-`VID:PID` DTR/RTS profiles (`DTR=ON` for native USB CDC-ACM, `DTR=OFF` for external UART bridges), and supports `100ms` MCU reset pulses (`RST`) plus multi-port switching (`[P0 / P1]`).
* **Dual-Buffer Engine:** 10,000-chunk / 2 MB `RingBuffer` keeps raw `Uint8Array` payloads and millisecond timestamps for instant, non-destructive switching between `ASCII`, `HEX`, `Timestamps`, and `Invisible Chars`.
* **xterm.js Terminal Viewport:** Hardware-accelerated ANSI/VT100 rendering, two-finger pinch-to-zoom (`9px`–`24px`) on mobile + `Ctrl+Wheel` / `-` / `+` zoom on desktop, and Smart Auto-Scroll Lock (`↓ Resume`).
* **Mobile Ergonomics:** Dedicated `TAB`, `↑`, `↓`, `Ctrl+C`, `ESC` keys, customizable macro chips (long-press or right-click to edit), `CRLF`/`LF`/`CR`/`RAW` selector, Local Echo, Screen Wake Lock while connected, and `visualViewport` keyboard avoidance.

## Development

```bash
npm install
npm run dev
```

Run checks and production build:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

> **Note:** Browsers require a secure context (`https://` or `http://localhost`) for Web Serial and WebUSB hardware access.
