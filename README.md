# HotWire Serial Terminal — Cross-Platform Web Serial & WebUSB PWA

[![Deploy to GitHub Pages](https://github.com/hotwire-lab/serial/actions/workflows/deploy.yml/badge.svg)](https://github.com/hotwire-lab/serial/actions/workflows/deploy.yml)
[![Live Web App](https://img.shields.io/badge/Live_Web_App-GitHub_Pages-0ea5e9?logo=googlechrome&logoColor=white)](https://hotwire-lab.github.io/serial/)
[![Hardware](https://img.shields.io/badge/Drivers-CDC--ACM_%7C_FTDI_%7C_CP210x_%7C_CH340_%7C_PL2303-10b981)](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API)
[![Web Serial & WebUSB](https://img.shields.io/badge/USB-Web_Serial_%2F_WebUSB-8b5cf6)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
[![Rust + WASM](https://img.shields.io/badge/Stack-Rust_%2B_Leptos_WASM-f97316?logo=rust&logoColor=white)](https://leptos.dev/)

A zero-install, offline-capable Progressive Web App (PWA) USB Serial Terminal built with **Rust + WebAssembly** ([Leptos](https://leptos.dev/) CSR + [Trunk](https://trunkrs.dev/) + [`hotwire-core`](https://github.com/hotwire-lab/hotwire-core)) for both **Desktop PCs** and **Android mobile devices**.

> **Try it in 1 click (no hardware required):** Open **[https://hotwire-lab.github.io/serial/](https://hotwire-lab.github.io/serial/)** and click **Demo** to test the interactive ESP32-S3 serial shell.

![HotWire Serial Terminal running in Demo mode with ASCII/HEX views, DTR/RTS/RST controls, and customizable macros](docs/serial-terminal-preview.jpg)

## Transport & Bridge Support

* **Direct USB Mode (PC & Android):**
  * **Desktop (Chrome, Edge, Brave on Windows / macOS / Linux / ChromeOS):** Uses **Web Serial API** (`navigator.serial`) by default for native OS serial drivers, with optional **WebUSB** (`navigator.usb`) fallback.
  * **Mobile (Chrome / Edge on Android 8+):** Automatically uses **WebUSB API** (`navigator.usb`) with built-in user-space drivers (`CDC-ACM`, `FTDI`, `Silicon Labs CP210x`, `QinHeng CH340/CH341/CH9102`, `Prolific PL2303`).
  * Works with any standard USB serial device without HotWire handshake restrictions.
* **XIAO ESP32 UART Bridge Mode (`D6 / D7`, 3.3 V TTL, `v1.0.0+`):**
  * Turns a **Seeed Studio XIAO ESP32-S3** (`D6 / GPIO 43` TX, `D7 / GPIO 44` RX) or **XIAO ESP32-C6** (`D6 / GPIO 16` TX, `D7 / GPIO 17` RX) into a dedicated hardware USB-to-UART bridge for probing external embedded targets.
  * Automatically verifies the connected board's target firmware and version (`v1.0.0+`) via `hotwire-core` — if another HotWire firmware or outdated version is detected, the app disconnects cleanly and displays a one-click **Flash Firmware** prompt.
  * Includes a **built-in Web Flasher** (`⚡ Flasher` in the top bar) with pre-compiled firmware binaries for both boards, plus software **Swap TX/RX (`D6 ↔ D7`)** and **Invert RX / TX** options in `⚙ Settings`.
  * **Firmware Sketches:**
    * [`firmware/HotWire_UART_XIAO_ESP32S3/HotWire_UART_XIAO_ESP32S3.ino`](firmware/HotWire_UART_XIAO_ESP32S3/HotWire_UART_XIAO_ESP32S3.ino)
    * [`firmware/HotWire_UART_XIAO_ESP32C6/HotWire_UART_XIAO_ESP32C6.ino`](firmware/HotWire_UART_XIAO_ESP32C6/HotWire_UART_XIAO_ESP32C6.ino)
* **Demo Mode:**
  * Simulated `ESP32-S3 Demo` firmware shell works offline on any browser (including devices without USB hardware).

## Key Features

* **Unified HotWire Top Bar & Tool Switcher:** Jump seamlessly between **Logic**, **Scope**, **SDR**, and **Serial** from the shared `hotwire-core` toolbar.
* **Authorized Auto-Reconnect & Smart Defaults:** Reconnects previously granted USB devices via `getPorts()` / `getDevices()`, applies per-`VID:PID` DTR/RTS profiles (`DTR=ON` for native USB CDC-ACM, `DTR=OFF` for external UART bridges), and supports `100 ms` MCU reset pulses (`RST`) plus multi-port switching (`[P0 / P1]`).
* **Incremental Ring-Buffer Viewport:** 10,000-chunk / 2 MB `RingBuffer` retains raw payloads and millisecond timestamps for instant, non-destructive switching between `ASCII`, `HEX`, `Timestamps`, and `Invisible Chars`. Incoming bursts append incrementally and coalesce DOM updates on `requestAnimationFrame`, with `Ctrl+Wheel` / `A−` / `A+` zoom (`9 px`–`24 px`), ANSI CSI stripping, log export (`.txt`), and Smart Auto-Scroll Lock (`↓ Resume`).
* **Workflow Ergonomics:** Dedicated `Ctrl+C`, `ESC`, `TAB` keys, command history (`↑` / `↓`), customizable macro chips (right-click or edit in Settings), `CRLF`/`LF`/`CR`/`RAW` selector, Local Echo, and Screen Wake Lock while connected.

## HotWire Ecosystem

* **[`hotwire-core`](https://github.com/hotwire-lab/hotwire-core)** — Shared Rust/WASM hardware transport, framing, firmware verification, Web Flasher & UI shell
* **[HotWire Serial Terminal](https://github.com/hotwire-lab/serial)** ([Live App](https://hotwire-lab.github.io/serial/)) — Cross-platform Web Serial & WebUSB terminal for desktop and Android
* **[HotWire Oscilloscope](https://github.com/hotwire-lab/scope)** ([Live App](https://hotwire-lab.github.io/scope/)) — 4-Channel 12-bit GDMA ADC Oscilloscope & FFT Spectrum Analyzer
* **[HotWire Logic Analyzer](https://github.com/hotwire-lab/logic)** ([Live App](https://hotwire-lab.github.io/logic/)) — 8-Channel Logic Analyzer & Tri-State Force I/O with UART/SPI/I²C decoders
* **[HotWire SDR](https://github.com/hotwire-lab/sdr)** ([Live App](https://hotwire-lab.github.io/sdr/)) — 1.84–2.79 GHz RF Spectrum Analyzer, Wideband Scanner & Waterfall for XIAO ESP32-S3 & XIAO ESP32-C6

## Development

Built with **Rust + WebAssembly** ([Leptos](https://leptos.dev/) CSR + [Trunk](https://trunkrs.dev/) + `hotwire-core`).

```bash
rustup target add wasm32-unknown-unknown
cargo clippy --all-targets -- -D warnings
cargo test
trunk serve          # local dev server (http://127.0.0.1:8082)
trunk build --release
```

> **Note:** Browsers require a secure context (`https://` or `http://localhost`) for Web Serial and WebUSB hardware access.

## License

Copyright © 2026 Kari Vierimaa, Kempele — Licensed under the [Apache License 2.0](LICENSE).
