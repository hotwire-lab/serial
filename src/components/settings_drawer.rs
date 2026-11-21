use leptos::prelude::*;
use leptos::task::spawn_local;
use wasm_bindgen::JsCast;

use crate::storage::preferences::{HotWirePreferences, LineEnding};
use crate::transport::serial::SerialTransport;

#[component]
#[allow(clippy::too_many_arguments)]
pub fn SettingsDrawer(
    open: RwSignal<bool>,
    active_tab: RwSignal<String>,
    prefs: RwSignal<HotWirePreferences>,
    editing_macro_idx: RwSignal<Option<usize>>,
    serial_transport: StoredValue<SerialTransport, LocalStorage>,
    on_close: Callback<()>,
    on_update_serial_cfg: Callback<(u8, u8, u8, u8)>,
    on_update_bridge_flags: Callback<(bool, bool, bool)>,
    on_save_macro: Callback<(usize, String, String, LineEnding)>,
) -> impl IntoView {
    let m_label = RwSignal::new(String::new());
    let m_payload = RwSignal::new(String::new());
    let m_le = RwSignal::new(LineEnding::Crlf);

    let board_id = RwSignal::new("xiao_esp32s3".to_string());
    let flash_offset = RwSignal::new("0x10000".to_string());
    let flash_busy = RwSignal::new(false);
    let flash_progress = RwSignal::new(0u32);
    let flash_error = RwSignal::new(Option::<String>::None);
    let flash_logs = RwSignal::new(Vec::<String>::new());
    let custom_file = RwSignal::new_local(Option::<web_sys::File>::None);

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

    let start_flash = move |force_other_port: bool| {
        if flash_busy.get_untracked() {
            return;
        }
        flash_busy.set(true);
        flash_progress.set(0);
        flash_error.set(None);
        flash_logs.set(vec!["Initializing XIAO ESP32 Web Flasher...".to_string()]);

        let board = board_id.get_untracked();
        let offset = flash_offset.get_untracked();
        let file = custom_file.get_untracked();
        let transport = serial_transport.with_value(|t| t.clone());

        spawn_local(async move {
            let res = transport
                .flash_firmware(
                    &board,
                    force_other_port,
                    &offset,
                    file.as_ref(),
                    move |msg| {
                        flash_logs.update(|logs| {
                            logs.push(msg);
                            if logs.len() > 80 {
                                logs.remove(0);
                            }
                        });
                    },
                    move |pct| {
                        flash_progress.set(pct);
                    },
                )
                .await;

            if let Err(err) = res {
                flash_error.set(Some(err.clone()));
                flash_logs.update(|logs| logs.push(format!("Error: {err}")));
            } else {
                flash_progress.set(100);
                flash_logs.update(|logs| {
                    logs.push("Done! Select 'XIAO UART (D6/D7)' mode and Connect USB.".to_string());
                });
            }
            flash_busy.set(false);
        });
    };

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
                                <div class="form-grid">
                                    <label class="ctrl-field">
                                        <span class="group-label">"Target Board"</span>
                                        <select
                                            class="ctrl-select"
                                            prop:value=move || board_id.get()
                                            on:change=move |ev| board_id.set(event_target_value(&ev))
                                            disabled=move || flash_busy.get()
                                        >
                                            <option value="xiao_esp32s3">"Seeed Studio XIAO ESP32-S3 (D6=GPIO43 TX, D7=GPIO44 RX)"</option>
                                            <option value="xiao_esp32c6">"Seeed Studio XIAO ESP32-C6 (D6=GPIO16 TX, D7=GPIO17 RX)"</option>
                                        </select>
                                    </label>

                                    <label class="ctrl-field">
                                        <span class="group-label">"Custom .bin (optional)"</span>
                                        <input
                                            type="file"
                                            accept=".bin"
                                            class="cmd-input"
                                            disabled=move || flash_busy.get()
                                            on:change=move |ev| {
                                                let file = ev
                                                    .target()
                                                    .and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok())
                                                    .and_then(|input| input.files())
                                                    .and_then(|list| list.get(0));
                                                custom_file.set(file);
                                            }
                                        />
                                    </label>
                                </div>

                                <div class="inline-controls">
                                    {move || custom_file.get().map(|_| view! {
                                        <label class="ctrl-field">
                                            <span class="group-label">"Offset"</span>
                                            <input
                                                type="text"
                                                class="cmd-input cmd-input-sm"
                                                prop:value=move || flash_offset.get()
                                                on:input=move |ev| flash_offset.set(event_target_value(&ev))
                                            />
                                        </label>
                                    })}
                                    <button
                                        type="button"
                                        class="btn btn-primary"
                                        disabled=move || flash_busy.get()
                                        on:click=move |_| start_flash(false)
                                    >
                                        {move || if flash_busy.get() { "Flashing..." } else { "⚡ Flash Firmware" }}
                                    </button>
                                    <button
                                        type="button"
                                        class="btn btn-secondary"
                                        disabled=move || flash_busy.get()
                                        on:click=move |_| start_flash(true)
                                    >
                                        "Select Other Port"
                                    </button>
                                </div>

                                <div class="progress-bar">
                                    <div
                                        class="progress-fill"
                                        style=move || format!("width: {}%;", flash_progress.get())
                                    />
                                </div>

                                {move || flash_error.get().map(|err| view! {
                                    <div class="flash-error">{err}</div>
                                })}

                                <pre class="flash-log">
                                    {move || flash_logs.get().join("\n")}
                                </pre>
                            </div>

                            <div class="drawer-col">
                                <h4>"XIAO UART Bridge Wiring (3.3 V TTL)"</h4>
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
