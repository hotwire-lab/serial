use hotwire_core::protocol::{BoardIdentity, ToolId};
use hotwire_core::ui::HotWireToolbar;
use leptos::prelude::*;

use crate::protocol::BridgeCapabilities;
use crate::storage::preferences::{HotWirePreferences, TerminalMode, BAUD_RATES};
use crate::transport::serial::TransportSnapshot;

#[component]
#[allow(clippy::too_many_arguments)]
pub fn TopToolbar(
    transport: RwSignal<TransportSnapshot>,
    identity: RwSignal<Option<BoardIdentity>>,
    prefs: RwSignal<HotWirePreferences>,
    bridge_caps: RwSignal<Option<BridgeCapabilities>>,
    settings_open: RwSignal<bool>,
    on_connect: Callback<()>,
    on_disconnect: Callback<()>,
    on_start_demo: Callback<()>,
    on_mode_change: Callback<TerminalMode>,
    on_baud_change: Callback<u32>,
    on_toggle_auto_connect: Callback<()>,
    on_toggle_dtr: Callback<()>,
    on_toggle_rts: Callback<()>,
    on_pulse_rst: Callback<()>,
    on_switch_port: Callback<u32>,
    on_open_flasher: Callback<()>,
) -> impl IntoView {
    let is_active = move || transport.get().status.is_active();

    let subtitle = Signal::derive(move || {
        if prefs.get().mode == TerminalMode::XiaoUartBridge {
            bridge_caps
                .get()
                .map(|c| format!("XIAO UART {}:{} · Rust/WASM", c.tx_pin, c.rx_pin))
                .unwrap_or_else(|| "XIAO UART Bridge (D6/D7)".to_string())
        } else {
            "Web Serial & WebUSB · Rust/WASM".to_string()
        }
    });

    view! {
        <HotWireToolbar
            active_tool=ToolId::SerialTerminal
            subtitle=subtitle
            transport=transport
            identity=identity
            on_connect=on_connect
            on_disconnect=on_disconnect
            on_start_demo=on_start_demo
            flasher_open=settings_open
            on_toggle_flasher=on_open_flasher
        >
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
                if is_active() {
                    Some(view! {
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
                    })
                } else {
                    None
                }
            }}

            <button
                type="button"
                class=move || if prefs.get().auto_connect { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                on:click=move |_| on_toggle_auto_connect.run(())
                title="Auto-connect on startup and automatically reconnect if USB device disappears and returns"
            >
                "Auto"
            </button>

            <button
                type="button"
                class=move || if settings_open.get() { "btn btn-secondary active" } else { "btn btn-secondary" }
                on:click=move |_| settings_open.update(|v| *v = !*v)
                title="Serial Framing, Bridge & Macro Editor"
            >
                "⚙ Settings"
            </button>
        </HotWireToolbar>
    }
}
