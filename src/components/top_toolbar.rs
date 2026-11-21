use leptos::prelude::*;

use crate::protocol::BridgeCapabilities;
use crate::storage::preferences::{HotWirePreferences, TerminalMode, BAUD_RATES};
use crate::transport::serial::{ConnectionStatus, TransportSnapshot};

#[component]
#[allow(clippy::too_many_arguments)]
pub fn TopToolbar(
    transport: RwSignal<TransportSnapshot>,
    prefs: RwSignal<HotWirePreferences>,
    bridge_caps: RwSignal<Option<BridgeCapabilities>>,
    settings_open: RwSignal<bool>,
    on_connect: Callback<()>,
    on_disconnect: Callback<()>,
    on_start_demo: Callback<()>,
    on_mode_change: Callback<TerminalMode>,
    on_baud_change: Callback<u32>,
    on_toggle_dtr: Callback<()>,
    on_toggle_rts: Callback<()>,
    on_pulse_rst: Callback<()>,
    on_switch_port: Callback<u32>,
    on_open_flasher: Callback<()>,
) -> impl IntoView {
    let is_connected = move || transport.get().status == ConnectionStatus::Connected;
    let is_connecting = move || transport.get().status == ConnectionStatus::Connecting;

    let status_class = move || format!("status-pill status-{}", transport.get().status.as_class());
    let status_title = move || {
        let t = transport.get();
        t.error_message.unwrap_or(t.device_name)
    };
    let status_label = move || {
        let t = transport.get();
        match t.status {
            ConnectionStatus::Connected => t.device_name,
            ConnectionStatus::Connecting => "Connecting...".to_string(),
            ConnectionStatus::Waiting => "Disconnected".to_string(),
        }
    };

    view! {
        <header class="top-toolbar">
            <div class="toolbar-row">
                <div class="brand-cluster">
                    <div class="brand-logo" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="20" height="20">
                            <path
                                d="M4 7l5 5-5 5M12 17h8"
                                fill="none"
                                stroke="#38bdf8"
                                stroke-width="2.2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            />
                        </svg>
                    </div>
                    <div class="brand-text">
                        <span class="brand-title">"HotWire Serial Terminal"</span>
                        <span class="brand-badge">"Web Serial & WebUSB · Rust/WASM"</span>
                    </div>
                </div>

                <div class=status_class title=status_title>
                    <span class="status-dot" />
                    <span class="status-label">{status_label}</span>
                    {move || {
                        let t = transport.get();
                        if t.status == ConnectionStatus::Connected && !t.vid_pid.is_empty() {
                            Some(view! { <span class="status-vidpid">{t.vid_pid}</span> })
                        } else {
                            None
                        }
                    }}
                    {move || {
                        if prefs.get().mode == TerminalMode::XiaoUartBridge {
                            let label = bridge_caps
                                .get()
                                .map(|c| format!("UART {}:{}", c.tx_pin, c.rx_pin))
                                .unwrap_or_else(|| "D6/D7 Bridge".to_string());
                            Some(view! { <span class="status-vidpid">{label}</span> })
                        } else {
                            None
                        }
                    }}
                </div>

                <div class="control-spacer" />

                <div class="toolbar-actions">
                    <select
                        class="ctrl-select"
                        aria-label="Serial mode"
                        title="Select Direct USB serial or XIAO ESP32 UART Bridge (D6/D7)"
                        prop:value=move || prefs.get().mode.as_str()
                        on:change=move |ev| {
                            let mode = TerminalMode::from_str(&event_target_value(&ev));
                            on_mode_change.run(mode);
                        }
                    >
                        <option value="direct">"Direct USB"</option>
                        <option value="bridge">"XIAO UART (D6/D7)"</option>
                    </select>

                    <select
                        class="ctrl-select"
                        aria-label="Baud rate"
                        prop:value=move || prefs.get().serial.baud_rate.to_string()
                        on:change=move |ev| {
                            if let Ok(b) = event_target_value(&ev).parse::<u32>() {
                                on_baud_change.run(b);
                            }
                        }
                    >
                        {BAUD_RATES
                            .into_iter()
                            .map(|b| view! { <option value=b.to_string()>{format!("{b} baud")}</option> })
                            .collect_view()}
                    </select>

                    {move || {
                        let t = transport.get();
                        if t.port_count > 1 {
                            Some(view! {
                                <div class="inline-controls">
                                    {(0..t.port_count)
                                        .map(|idx| {
                                            view! {
                                                <button
                                                    type="button"
                                                    class=move || {
                                                        if transport.get().port_index == idx {
                                                            "btn btn-sm btn-accent active"
                                                        } else {
                                                            "btn btn-sm btn-secondary"
                                                        }
                                                    }
                                                    on:click=move |_| on_switch_port.run(idx)
                                                >
                                                    {format!("P{idx}")}
                                                </button>
                                            }
                                        })
                                        .collect_view()}
                                </div>
                            })
                        } else {
                            None
                        }
                    }}

                    {move || {
                        if is_connected() {
                            view! {
                                <button
                                    type="button"
                                    class=move || if transport.get().dtr { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                                    on:click=move |_| on_toggle_dtr.run(())
                                    title="Toggle DTR line"
                                >
                                    "DTR"
                                </button>
                                <button
                                    type="button"
                                    class=move || if transport.get().rts { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                                    on:click=move |_| on_toggle_rts.run(())
                                    title="Toggle RTS line"
                                >
                                    "RTS"
                                </button>
                                <button
                                    type="button"
                                    class="btn btn-sm btn-secondary"
                                    on:click=move |_| on_pulse_rst.run(())
                                    title="Send 100ms MCU hardware reset pulse"
                                >
                                    "RST"
                                </button>
                                <button
                                    type="button"
                                    class="btn btn-ghost"
                                    on:click=move |_| on_disconnect.run(())
                                >
                                    "Disconnect"
                                </button>
                            }
                            .into_any()
                        } else {
                            view! {
                                <button
                                    type="button"
                                    class="btn btn-primary"
                                    disabled=is_connecting
                                    on:click=move |_| on_connect.run(())
                                >
                                    {move || if is_connecting() { "Connecting..." } else { "Connect USB" }}
                                </button>
                                <button
                                    type="button"
                                    class="btn btn-accent"
                                    on:click=move |_| on_start_demo.run(())
                                    title="Run offline ESP32-S3 demo serial shell"
                                >
                                    "Demo"
                                </button>
                            }
                            .into_any()
                        }
                    }}

                    <button
                        type="button"
                        class="btn btn-flash"
                        on:click=move |_| on_open_flasher.run(())
                        title="Flash XIAO ESP32-S3 / C6 UART Bridge Firmware"
                    >
                        "⚡ Flasher"
                    </button>
                    <button
                        type="button"
                        class=move || if settings_open.get() { "btn btn-secondary active" } else { "btn btn-secondary" }
                        on:click=move |_| settings_open.update(|v| *v = !*v)
                        title="Serial Framing, Bridge & Macro Editor"
                    >
                        "⚙ Settings"
                    </button>
                </div>
            </div>
        </header>
    }
}
