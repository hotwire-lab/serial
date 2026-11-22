use hotwire_core::flasher::{FirmwareProfile, FlasherPanel};
use hotwire_core::protocol::{BoardIdentity, FirmwareMismatch, ToolId};
use leptos::prelude::*;

use crate::storage::preferences::{HotWirePreferences, LineEnding, TerminalMode, BAUD_RATES};
use crate::transport::serial::{SerialTransport, TransportSnapshot};

fn uart_bridge_profiles() -> Vec<FirmwareProfile> {
    vec![
        FirmwareProfile::xiao_esp32s3(
            "HotWire_UART_XIAO_ESP32S3.ino",
            "3.3 V TTL USB-to-UART Bridge: D6 (GPIO43) TX, D7 (GPIO44) RX — live baud/framing, Swap TX/RX, Invert",
        ),
        FirmwareProfile::xiao_esp32c6(
            "HotWire_UART_XIAO_ESP32C6.ino",
            "3.3 V TTL USB-to-UART Bridge: D6 (GPIO16) TX, D7 (GPIO17) RX — live baud/framing, Swap TX/RX, Invert",
        ),
    ]
}

#[component]
#[allow(clippy::too_many_arguments)]
pub fn SettingsDrawer(
    open: RwSignal<bool>,
    active_tab: RwSignal<String>,
    transport: RwSignal<TransportSnapshot>,
    identity: RwSignal<Option<BoardIdentity>>,
    mismatch: RwSignal<Option<FirmwareMismatch>>,
    prefs: RwSignal<HotWirePreferences>,
    editing_macro_idx: RwSignal<Option<usize>>,
    serial_transport: StoredValue<SerialTransport, LocalStorage>,
    on_close: Callback<()>,
    on_mode_change: Callback<TerminalMode>,
    on_baud_change: Callback<u32>,
    on_toggle_auto_connect: Callback<()>,
    on_toggle_dtr: Callback<()>,
    on_toggle_rts: Callback<()>,
    on_pulse_rst: Callback<()>,
    on_switch_port: Callback<u32>,
    on_update_serial_cfg: Callback<(u8, u8, u8, u8)>,
    on_update_bridge_flags: Callback<(bool, bool, bool)>,
    on_save_macro: Callback<(usize, String, String, LineEnding)>,
) -> impl IntoView {
    let m_label = RwSignal::new(String::new());
    let m_payload = RwSignal::new(String::new());
    let m_le = RwSignal::new(LineEnding::Crlf);

    Effect::new(move |_| {
        if let Some(idx) = editing_macro_idx.get() {
            active_tab.set("settings".to_string());
            if let Some(m) = prefs.get_untracked().macros.get(idx) {
                m_label.set(m.label.clone());
                m_payload.set(m.payload.clone());
                m_le.set(m.line_ending);
            }
        }
    });

    view! {
        <div class=move || if open.get() || editing_macro_idx.get().is_some() { "drawer-backdrop open" } else { "drawer-backdrop" }>
            <aside class="bottom-drawer">
                <div class="drawer-header">
                    <div class="drawer-tabs">
                        <button
                            type="button"
                            class=move || if active_tab.get() == "settings" { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                            on:click=move |_| active_tab.set("settings".to_string())
                        >
                            "⚙ Framing, Bridge & Macros"
                        </button>
                        <button
                            type="button"
                            class=move || if active_tab.get() == "flasher" { "btn btn-sm btn-flash active" } else { "btn btn-sm btn-secondary" }
                            on:click=move |_| {
                                editing_macro_idx.set(None);
                                active_tab.set("flasher".to_string());
                            }
                        >
                            "⚡ XIAO Web Flasher & Pinout"
                        </button>
                    </div>
                    <button
                        type="button"
                        class="btn btn-sm btn-ghost"
                        on:click=move |_| {
                            editing_macro_idx.set(None);
                            on_close.run(());
                        }
                    >
                        "✕ Close"
                    </button>
                </div>

                {move || if active_tab.get() == "flasher" {
                    view! {
                        <div class="drawer-body">
                            <div class="drawer-col">
                                <h4>"XIAO ESP32 UART Bridge Web Flasher"</h4>
                                <FlasherPanel
                                    profiles=uart_bridge_profiles()
                                    transport=serial_transport
                                    expected_tool=ToolId::SerialTerminal
                                    identity=identity
                                    mismatch=mismatch
                                />
                            </div>

                            <div class="drawer-col">
                                <h4>"XIAO UART Bridge Wiring (3.3 V TTL)"</h4>
                                <div class="pin-table-wrap">
                                    <table class="pin-table">
                                        <thead>
                                            <tr>
                                                <th>"Signal"</th>
                                                <th>"XIAO ESP32-S3"</th>
                                                <th>"XIAO ESP32-C6"</th>
                                                <th>"Target Pin"</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr>
                                                <td>"UART TX"</td>
                                                <td>"D6 (GPIO 43)"</td>
                                                <td>"D6 (GPIO 16)"</td>
                                                <td>"Target RX"</td>
                                            </tr>
                                            <tr>
                                                <td>"UART RX"</td>
                                                <td>"D7 (GPIO 44)"</td>
                                                <td>"D7 (GPIO 17)"</td>
                                                <td>"Target TX"</td>
                                            </tr>
                                            <tr>
                                                <td>"GND"</td>
                                                <td>"GND"</td>
                                                <td>"GND"</td>
                                                <td>"Target GND"</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                                <div class="flash-warning">
                                    "⚠ 3.3 V logic only! Never connect 5 V RS-232 or 5 V TTL directly to XIAO pins without a level shifter. Use 'Swap TX/RX' in Framing & Bridge if you wired straight-through."
                                </div>
                            </div>
                        </div>
                    }.into_any()
                } else {
                    view! {
                        <div class="drawer-body">
                            <div class="drawer-col">
                                <div class="mobile-serial-controls hw-mobile-only">
                                    <h4>"Serial Connection"</h4>
                                    <div class="form-grid">
                                        <label class="ctrl-field">
                                            <span class="group-label">"Mode"</span>
                                            <select
                                                class="ctrl-select"
                                                aria-label="Serial mode"
                                                prop:value=move || prefs.get().mode.as_str()
                                                on:change=move |ev| {
                                                    let mode = TerminalMode::from_str(&event_target_value(&ev));
                                                    on_mode_change.run(mode);
                                                }
                                            >
                                                <option value="direct">"Direct USB"</option>
                                                <option value="bridge">"XIAO UART (D6/D7)"</option>
                                            </select>
                                        </label>

                                        <label class="ctrl-field">
                                            <span class="group-label">"Baud Rate"</span>
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
                                        </label>
                                    </div>

                                    <div class="inline-controls">
                                        <button
                                            type="button"
                                            class=move || if prefs.get().auto_connect { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                                            on:click=move |_| on_toggle_auto_connect.run(())
                                        >
                                            "Auto-Reconnect"
                                        </button>

                                        {move || {
                                            let t = transport.get();
                                            if t.port_count > 1 {
                                                Some(view! {
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
                                                })
                                            } else {
                                                None
                                            }
                                        }}

                                        {move || {
                                            if transport.get().status.is_active() {
                                                Some(view! {
                                                    <button
                                                        type="button"
                                                        class=move || if transport.get().dtr { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                                                        on:click=move |_| on_toggle_dtr.run(())
                                                    >
                                                        "DTR"
                                                    </button>
                                                    <button
                                                        type="button"
                                                        class=move || if transport.get().rts { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                                                        on:click=move |_| on_toggle_rts.run(())
                                                    >
                                                        "RTS"
                                                    </button>
                                                    <button
                                                        type="button"
                                                        class="btn btn-sm btn-secondary"
                                                        on:click=move |_| on_pulse_rst.run(())
                                                    >
                                                        "RST"
                                                    </button>
                                                })
                                            } else {
                                                None
                                            }
                                        }}
                                    </div>
                                </div>

                                <h4>"UART Framing & XIAO Bridge"</h4>
                                <div class="form-grid">
                                    <label class="ctrl-field">
                                        <span class="group-label">"Data Bits"</span>
                                        <select
                                            class="ctrl-select"
                                            prop:value=move || prefs.get().serial.data_bits.to_string()
                                            on:change=move |ev| {
                                                if let Ok(db) = event_target_value(&ev).parse::<u8>() {
                                                    let s = prefs.get_untracked().serial;
                                                    on_update_serial_cfg.run((db, s.stop_bits, s.parity, s.flow_control));
                                                }
                                            }
                                        >
                                            <option value="8">"8 bits"</option>
                                            <option value="7">"7 bits"</option>
                                        </select>
                                    </label>

                                    <label class="ctrl-field">
                                        <span class="group-label">"Parity"</span>
                                        <select
                                            class="ctrl-select"
                                            prop:value=move || prefs.get().serial.parity.to_string()
                                            on:change=move |ev| {
                                                if let Ok(par) = event_target_value(&ev).parse::<u8>() {
                                                    let s = prefs.get_untracked().serial;
                                                    on_update_serial_cfg.run((s.data_bits, s.stop_bits, par, s.flow_control));
                                                }
                                            }
                                        >
                                            <option value="0">"None (N)"</option>
                                            <option value="1">"Odd (O)"</option>
                                            <option value="2">"Even (E)"</option>
                                        </select>
                                    </label>

                                    <label class="ctrl-field">
                                        <span class="group-label">"Stop Bits"</span>
                                        <select
                                            class="ctrl-select"
                                            prop:value=move || prefs.get().serial.stop_bits.to_string()
                                            on:change=move |ev| {
                                                if let Ok(sb) = event_target_value(&ev).parse::<u8>() {
                                                    let s = prefs.get_untracked().serial;
                                                    on_update_serial_cfg.run((s.data_bits, sb, s.parity, s.flow_control));
                                                }
                                            }
                                        >
                                            <option value="1">"1 bit"</option>
                                            <option value="2">"2 bits"</option>
                                        </select>
                                    </label>

                                    <label class="ctrl-field">
                                        <span class="group-label">"Flow Control (Direct USB)"</span>
                                        <select
                                            class="ctrl-select"
                                            prop:value=move || prefs.get().serial.flow_control.to_string()
                                            on:change=move |ev| {
                                                if let Ok(fc) = event_target_value(&ev).parse::<u8>() {
                                                    let s = prefs.get_untracked().serial;
                                                    on_update_serial_cfg.run((s.data_bits, s.stop_bits, s.parity, fc));
                                                }
                                            }
                                        >
                                            <option value="0">"None"</option>
                                            <option value="1">"RTS / CTS"</option>
                                        </select>
                                    </label>
                                </div>

                                <div class="inline-controls bridge-flags">
                                    <button
                                        type="button"
                                        class=move || if prefs.get().bridge_swap_pins { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                                        on:click=move |_| {
                                            let p = prefs.get_untracked();
                                            on_update_bridge_flags.run((!p.bridge_swap_pins, p.bridge_invert_rx, p.bridge_invert_tx));
                                        }
                                        title="Swap D6 and D7 roles on XIAO UART Bridge"
                                    >
                                        "Swap TX/RX (D6↔D7)"
                                    </button>
                                    <button
                                        type="button"
                                        class=move || if prefs.get().bridge_invert_rx { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                                        on:click=move |_| {
                                            let p = prefs.get_untracked();
                                            on_update_bridge_flags.run((p.bridge_swap_pins, !p.bridge_invert_rx, p.bridge_invert_tx));
                                        }
                                        title="Invert RX signal polarity on XIAO UART Bridge"
                                    >
                                        "Invert RX"
                                    </button>
                                    <button
                                        type="button"
                                        class=move || if prefs.get().bridge_invert_tx { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                                        on:click=move |_| {
                                            let p = prefs.get_untracked();
                                            on_update_bridge_flags.run((p.bridge_swap_pins, p.bridge_invert_rx, !p.bridge_invert_tx));
                                        }
                                        title="Invert TX signal polarity on XIAO UART Bridge"
                                    >
                                        "Invert TX"
                                    </button>
                                </div>
                            </div>

                            <div class="drawer-col">
                                <h4>"Macro Buttons"</h4>
                                <div class="inline-controls">
                                    {move || {
                                        prefs
                                            .get()
                                            .macros
                                            .into_iter()
                                            .enumerate()
                                            .map(|(idx, m)| {
                                                view! {
                                                    <button
                                                        type="button"
                                                        class=move || if editing_macro_idx.get() == Some(idx) { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                                                        on:click=move |_| editing_macro_idx.set(Some(idx))
                                                    >
                                                        {format!("Edit: {}", m.label)}
                                                    </button>
                                                }
                                            })
                                            .collect_view()
                                    }}
                                </div>

                                {move || {
                                    editing_macro_idx.get().map(|idx| {
                                        view! {
                                            <div class="macro-editor-box">
                                                <input
                                                    type="text"
                                                    class="cmd-input"
                                                    placeholder="Label"
                                                    prop:value=move || m_label.get()
                                                    on:input=move |ev| m_label.set(event_target_value(&ev))
                                                />
                                                <input
                                                    type="text"
                                                    class="cmd-input"
                                                    placeholder="Payload"
                                                    prop:value=move || m_payload.get()
                                                    on:input=move |ev| m_payload.set(event_target_value(&ev))
                                                />
                                                <select
                                                    class="ctrl-select ctrl-select-sm"
                                                    prop:value=move || m_le.get().as_str()
                                                    on:change=move |ev| m_le.set(LineEnding::from_str(&event_target_value(&ev)))
                                                >
                                                    <option value="CRLF">"CRLF"</option>
                                                    <option value="LF">"LF"</option>
                                                    <option value="CR">"CR"</option>
                                                    <option value="RAW">"RAW"</option>
                                                </select>
                                                <button
                                                    type="button"
                                                    class="btn btn-sm btn-primary"
                                                    on:click=move |_| {
                                                        on_save_macro.run((idx, m_label.get_untracked(), m_payload.get_untracked(), m_le.get_untracked()));
                                                        editing_macro_idx.set(None);
                                                    }
                                                >
                                                    "Save Macro"
                                                </button>
                                            </div>
                                        }
                                    })
                                }}
                            </div>
                        </div>
                    }.into_any()
                }}
            </aside>
        </div>
    }
}
