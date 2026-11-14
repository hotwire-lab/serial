# Project Specification: HotWire — Cross-Platform USB Serial Terminal PWA (Desktop & Mobile)

## 1. Project Identity & Core Philosophy
* **Application Name:** HotWire (Cross-Platform USB Serial Terminal PWA)
* **Core Concept:** Build a modern, zero-install Progressive Web App (PWA) USB Serial Terminal designed to run seamlessly on both **Desktop PCs** (Windows, macOS, Linux, ChromeOS) and **Mobile Devices** (Android phones & tablets via Chrome / Edge / Chromium browsers). Designed from first principles for embedded systems engineers, hardware bring-up, and field technicians.
* **Hybrid Auto-Reconnect & Instant Access:** On every launch, the app checks previously authorized USB/serial devices (`navigator.serial.getPorts()` / `navigator.usb.getDevices()`) for automatic reconnection without dialogs, while providing an explicit one-tap `Connect USB` button (required by browser security policies for initial hardware pairing) and recovering gracefully across unplug/replug cycles without losing terminal history.
* **No App Store or APK Required:** Served over HTTPS (or `localhost` in development), installable to the Home Screen / Desktop Dock, and fully functional offline once cached via a Service Worker.

---

## 2. Target Platform & Tech Stack
* **Target Platforms:**
  * **Desktop:** Chromium-based browsers (Chrome, Edge, Brave, Opera) on Windows, macOS, Linux, and ChromeOS using native **Web Serial API** (`navigator.serial`) as primary transport and **WebUSB API** (`navigator.usb`) as secondary/fallback transport.
  * **Mobile (Android 8+):** Chrome / Edge / Chromium on Android using **WebUSB API** (`navigator.usb`) with built-in user-space TypeScript UART & CDC-ACM drivers (because Android Chrome does not expose `navigator.serial`).
* **Framework & Tooling:** Vite + React 19 + TypeScript (strict mode), zero legacy React Native or Expo dependencies.
* **Terminal Rendering Engine:** Direct DOM `@xterm/xterm` (`@xterm/addon-fit` and `@xterm/addon-canvas`) mounted natively in a responsive viewport (no WebView iframe wrapper), bundled statically by Vite so it operates completely offline.
* **Dual-Transport Serial Engine (`SerialManager`):**
  * **Transport A — Web Serial API (`navigator.serial`):** Used automatically on Desktop Chromium browsers; delegates UART chip handling to OS kernel drivers.
  * **Transport B — WebUSB API (`navigator.usb`):** Used on Android mobile devices (and selectable on Desktop) with pure-TypeScript protocol drivers implementing USB control transfers and bulk IN/OUT endpoints for:
    * **USB CDC-ACM** (Espressif ESP32-S3/C6/C3, RP2040/Pico, STM32 VCP, Nordic nRF52840, Arduino native USB)
    * **FTDI** (`FT232R`, `FT232H`, `FT2232`, `FT4232`, `FT231X`)
    * **Silicon Labs CP210x** (`CP2102`, `CP2104`, `CP2105`, `CP2108`)
    * **QinHeng CH34x** (`CH340`, `CH341`, `CH9102`)
    * **Prolific PL2303** (classic & HXN variants)
  * **Offline Simulated Demo Mode (`ESP32-S3 Demo`):** Built-in interactive firmware simulator for testing terminal workflows, macros, and view formatters on browsers or devices without WebUSB/WebSerial hardware (e.g., iOS Safari or hardware-less demos).
* **PWA Offline Support:** Web App Manifest (`manifest.webmanifest`) + Service Worker (`sw.js`) implementing cache-first static asset serving with runtime network fallback.
* **Power Management:** Screen Wake Lock API (`navigator.wakeLock.request('screen')`) automatically acquired while in the `CONNECTED` state (and re-acquired on `visibilitychange`) and released on disconnect.
* **Local Persistence:** `localStorage` (wrapped with in-memory fallback for non-DOM test environments) storing baud/framing settings, custom macros, view toggles, font size, line endings, and per-`VID:PID` hardware profiles.

---

## 3. PWA Lifecycle, Security & Transport Selection
1. **Secure Context Enforcement:** Web Serial and WebUSB require a secure context (`https://` or `http://localhost` / `http://127.0.0.1`). If opened over plain LAN `http://`, the UI must clearly notify the user that HTTPS is required for hardware access.
2. **Automatic Capability Detection:**
   * On startup, detect `'serial' in navigator`, `'usb' in navigator`, and current browser form factor.
   * On Desktop with both APIs available, prefer **Web Serial** by default while allowing users to switch to **WebUSB** when needed (e.g., dual-interface probes or driverless boards). On Android Chrome where `navigator.serial` is absent, automatically select **WebUSB**.
3. **Authorized Device Auto-Reconnect:**
   * Subscribe to `navigator.serial.connect` / `disconnect` and `navigator.usb.connect` / `disconnect`.
   * On initial load or device replug, probe already-granted ports/devices (`getPorts()` / `getDevices()`); if a matching device is found and no session is active, automatically open it without displaying a browser permission picker.
4. **User-Gesture Device Picker:** Clicking/tapping `Connect USB` calls `navigator.serial.requestPort()` or `navigator.usb.requestDevice({ filters })` directly inside the click handler so the browser grants device permission cleanly.

---

## 4. Serial Engine & State Machine

### 4.1 Connection State Machine
The `SerialManager` manages hardware lifecycles and publishes immutable state snapshots to the React UI:
* **State 1: `LISTENING` (Disconnected):** No device active. UI remains interactive for scrolling, searching/inspecting history, toggling formats, or exporting logs. Status pill displays `"Ready — Tap Connect USB"` (or browser transport status).
* **State 2: `HANDSHAKING` (Connecting):** Device/port selected; claims WebUSB interface or opens Web Serial port, applies line coding (`115200, 8N1` or user preference), and configures initial `DTR`/`RTS` lines.
* **State 3: `CONNECTED` (Active Stream):** Continuous async read loop streaming bytes into the RX batcher. Appends an inline system separator (`--- Connected [Device Name • Port X] (HH:MM:SS) ---`) and acquires Screen Wake Lock.
* **State 4: `DISCONNECTED` (Detached):** Triggered on physical unplug, user disconnect, or transfer error. Cleanly cancels/closes readers/writers, releases claimed WebUSB interfaces, appends (`--- Disconnected (HH:MM:SS) ---`), releases Screen Wake Lock, and transitions back to `LISTENING` while keeping terminal history intact.

### 4.2 Multi-Port / Multi-Interface Support
Composite debuggers and MCUs (e.g., ESP32-S3 USB-JTAG/Serial, FT2232, Dual CP2105) expose multiple serial interfaces/ports:
* **WebUSB:** Inspects all USB configurations/interfaces with CDC Communication/Data or vendor serial endpoints; enumerates total port count (`portCount`) and remembers last-used interface index per `VID:PID`.
* If `portCount > 1`, a compact `[P0 / P1]` switcher becomes visible in the top bar for instant port switching.

### 4.3 Hardware Control Lines (DTR & RTS)
* **Smart Hardware Profiles (Per `VID:PID`):**
  * **Native USB CDC-ACM** (Espressif `0x303A`, RP2040 `0x2E8A`, Nordic `0x1915`, Arduino `0x2341`, STM32/OpenMoko `0x1D50`): defaults to `DTR = ON`, `RTS = OFF` so target firmware begins transmitting immediately.
  * **External USB-UART Bridges** (FTDI `0x0403`, CP210x `0x10C4`, CH34x `0x1A86`, PL2303 `0x067B`): defaults to `DTR = OFF`, `RTS = OFF` to prevent unintended auto-reset or bootloader strapping.
  * Manual `DTR`/`RTS` changes for a `VID:PID` are persisted and reapplied automatically on subsequent reconnects.
* **Manual Override & MCU Reset:** Dedicated `DTR` and `RTS` toggle pills in the top bar plus a `RST` action that pulses the lines low/active for `100ms` before restoring their previous states to reboot microcontrollers on demand.

### 4.4 High-Throughput Data Batching (Throttling)
To maintain 60 fps rendering during high-speed serial bursts (`921600+` baud):
* Incoming `Uint8Array` chunks from the serial read loop accumulate in an RX queue and flush to React/xterm on a **20ms timer (50 Hz)** or immediately when buffered bytes reach **16 KB**.

---

## 5. Data Pipeline & Dual-Buffer Architecture

### 5.1 Ring Buffer Storage (Source of Truth)
A fixed-capacity circular buffer (`RingBuffer`) holds up to **10,000 chunks** or **2 MB** of raw bytes. Each entry stores:
* Millisecond timestamp (`Date.now()`).
* Raw byte slice (`Uint8Array`).
* Entry type (`RX`, `TX`, or `SYSTEM_EVENT`).

### 5.2 Terminal Rendering & Format Switching
* **Streaming UTF-8 & ANSI/VT100:** Under `ASCII` mode, raw `Uint8Array` payloads stream directly into `terminal.write(bytes)` in `@xterm/xterm`, preserving multi-byte UTF-8 characters across USB packets, ANSI 16/256 colors, carriage returns (`\r`), and line clears (`\x1b[2K`).
* **Non-Destructive View Toggles:** Toggling **HEX View**, **Timestamps** (`[HH:MM:SS.mmm] `), or **Invisible Chars** (`␍`, `␊`, `␀`) clears the `xterm.js` display and deterministically replays the stored `RingBuffer` without losing any prior data.

---

## 6. Responsive Desktop & Mobile UI/UX Design

### 6.1 Visual Style & Ergonomics
* Dark, high-contrast lab theme (`#0D1117` terminal canvas, `#161B22` surface bars, `#30363D` hairline borders, `#3FB950` connected, `#D29922` standby/handshaking, `#F85149` error, `#58A6FF` interactive accent).
* Uses monospace font stack (`JetBrains Mono`, `Fira Code`, `Cascadia Code`, `ui-monospace`, `monospace`) with crisp box-drawing and control glyphs.
* Responsive single-screen CSS Grid/Flexbox layout (`100dvh`, `env(safe-area-inset-*)`, plus `window.visualViewport` resize tracking so Android virtual keyboards cleanly push the bottom input bar above the keyboard without obscuring viewport controls).

### 6.2 Top Control Bar
1. **Connection Pill & Action Button:** Status dot + device/transport label (`Connect USB` button when disconnected / `Disconnect` & port `[P0/P1]` switcher when connected; long-press or Demo toggle when no hardware is attached).
2. **Baud Rate & Framing Selector:** Quick baud popover (`9600`, `19200`, `38400`, `57600`, `115200`, `230400`, `460800`, `921600`) and serial framing controls (`8N1`, `8E1`, `8O1`, `7E1`, hardware RTS/CTS flow control).
3. **DTR / RTS / RST Toggles:** Real-time control line state indicators (`DTR`, `RTS`) and `RST` 100ms reset pulse button.
4. **View & Log Actions:** Compact toggles for `HEX`/`ASCII`, `Timestamps`, `Invisibles`, `Export Log` (uses Web Share API with file attachment on mobile or direct `.log` file download on desktop), and `Clear`.

### 6.3 Main Terminal Viewport (`@xterm/xterm`)
* Fills remaining height and auto-reflows columns immediately via `FitAddon` + `ResizeObserver` + `visualViewport` listeners whenever the browser window or mobile software keyboard resizes.
* **Smart Auto-Scroll Lock:** Follows live tail automatically; scrolling up locks the viewport at the user's inspection position and shows a floating `↓ Resume (X new chunks)` button at the bottom center.
* **Cross-Platform Zoom (`9px`–`24px`):**
  * **Mobile Touch:** Two-finger pinch gesture scales `terminal.options.fontSize` smoothly and re-runs `fitAddon.fit()`.
  * **Desktop:** `Ctrl`+Mouse Wheel, `Ctrl`+`+` / `Ctrl`+`-` (and compact `-` / `+` font controls on wide viewports) adjust font size cleanly.
* **Interactive Keyboard Support (Desktop & Bluetooth Keyboards):** Keystrokes typed directly into the focused terminal canvas on PC can optionally route straight to TX (or users can use the bottom command bar with history & line endings).

### 6.4 Bottom Command & Macro Bar
1. **Quick Shell Keys & Custom Macros Row:**
   * Fixed shell buttons: `TAB` (`\t`), `↑` (`\x1b[A`), `↓` (`\x1b[B`), `Ctrl+C` (`\x03`), and `ESC` (`\x1b`).
   * Editable one-tap macro buttons (long-press on mobile or right-click / edit icon on desktop opens the Macro Editor modal to edit label, payload, and line ending).
2. **Command Input Row:**
   * Input field with `autocorrect="off"`, `autocapitalize="none"`, `spellcheck={false}` and Up/Down command history recall on desktop.
   * Line Ending cycler (`CRLF`, `LF`, `CR`, `RAW`), `Echo` toggle (prints local TX commands in cyan), and `Send` button that preserves focus/keyboard on mobile.

---

## 7. Implementation Milestones
1. **Milestone 1: PWA Foundation, Offline Service Worker & Spec Alignment:** Initialize a clean Vite + React 19 + TypeScript workspace (`pwa/`) with Web App Manifest, Service Worker, icons, ESLint, and Vitest.
2. **Milestone 2: Dual-Transport Serial Engine (`Web Serial` + `WebUSB` + Demo):** Implement protocol drivers (`CDC-ACM`, `FTDI`, `CP210x`, `CH34x`, `PL2303`), smart per-`VID:PID` DTR/RTS profiles, 100ms reset pulse, multi-port switching, Screen Wake Lock, and 20ms/16KB RX batching.
3. **Milestone 3: Ring Buffer & Native DOM `xterm.js` Viewport:** Port/refine the `RingBuffer`, `formatters`, direct `@xterm/xterm` + `FitAddon` + `CanvasAddon` viewport with Smart Auto-Scroll Lock and cross-platform font zoom (`9px`–`24px`).
4. **Milestone 4: Responsive Desktop & Mobile UI, Verification & Clean GitHub Repository:** Build the responsive controls, `visualViewport` mobile keyboard avoidance, Web Share / file download log export, run lint/typecheck/tests/production build, and push to a dedicated clean GitHub repository.
