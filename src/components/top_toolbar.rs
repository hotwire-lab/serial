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
    subbar_open: RwSignal<bool>,
    settings_open: RwSignal<bool>,
    settings_tab: RwSignal<String>,
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
    on_toggle_flasher: Callback<()>,
) -> impl IntoView {
    let is_active = move || transport.get().status.is_active();
    let flasher_open =
        Signal::derive(move || settings_open.get() && settings_tab.get() == "flasher");

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
            flasher_open=flasher_open
            on_toggle_flasher=on_toggle_flasher
        >
            <select
                class="ctrl-select hw-desktop-only"
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
                class="ctrl-select hw-desktop-only"
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
                        <div class="inline-controls hw-desktop-only">
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
                            class=move || if transport.get().dtr { "btn btn-sm btn-accent active hw-desktop-only" } else { "btn btn-sm btn-secondary hw-desktop-only" }
                            on:click=move |_| on_toggle_dtr.run(())
                            title="Toggle DTR line"
                        >
                            "DTR"
                        </button>
                        <button
                            type="button"
                            class=move || if transport.get().rts { "btn btn-sm btn-accent active hw-desktop-only" } else { "btn btn-sm btn-secondary hw-desktop-only" }
                            on:click=move |_| on_toggle_rts.run(())
                            title="Toggle RTS line"
                        >
                            "RTS"
                        </button>
                        <button
                            type="button"
                            class="btn btn-sm btn-secondary hw-desktop-only"
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
                class=move || if prefs.get().auto_connect { "btn btn-sm btn-accent active hw-desktop-only" } else { "btn btn-sm btn-secondary hw-desktop-only" }
                on:click=move |_| on_toggle_auto_connect.run(())
                title="Auto-connect on startup and automatically reconnect if USB device disappears and returns"
            >
                "Auto"
            </button>

            <button
                type="button"
                class=move || {
                    if subbar_open.get() {
                        "btn btn-sm btn-accent active hw-mobile-only"
                    } else {
                        "btn btn-sm btn-secondary hw-mobile-only"
                    }
                }
                aria-expanded=move || if subbar_open.get() { "true" } else { "false" }
                on:click=move |_| subbar_open.update(|v| *v = !*v)
                title="Toggle View controls (ASCII/HEX, Time, Font, Clear)"
            >
                "View"
            </button>

            <button
                type="button"
                aria-label="Settings"
                class=move || {
                    if settings_open.get() && settings_tab.get() != "flasher" {
                        "btn btn-secondary active"
                    } else {
                        "btn btn-secondary"
                    }
                }
                on:click=move |_| {
                    if settings_open.get_untracked() && settings_tab.get_untracked() != "flasher" {
                        settings_open.set(false);
                    } else {
                        settings_tab.set("settings".to_string());
                        settings_open.set(true);
                    }
                }
                title="Serial Framing, Bridge & Macro Editor"
            >
                "⚙"
                <span class="hw-desktop-only">" Settings"</span>
            </button>
        </HotWireToolbar>
    }
}
