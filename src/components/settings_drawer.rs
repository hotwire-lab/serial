use leptos::prelude::*;

use crate::storage::preferences::{HotWirePreferences, LineEnding};

#[component]
pub fn SettingsDrawer(
    open: RwSignal<bool>,
    prefs: RwSignal<HotWirePreferences>,
    editing_macro_idx: RwSignal<Option<usize>>,
    on_close: Callback<()>,
    on_update_serial_cfg: Callback<(u8, u8, u8, u8)>,
    on_save_macro: Callback<(usize, String, String, LineEnding)>,
) -> impl IntoView {
    let m_label = RwSignal::new(String::new());
    let m_payload = RwSignal::new(String::new());
    let m_le = RwSignal::new(LineEnding::Crlf);

    Effect::new(move |_| {
        if let Some(idx) = editing_macro_idx.get() {
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
                    <h3>"⚙ Serial Port Framing & Macros"</h3>
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

                <div class="drawer-body">
                    <div class="drawer-col">
                        <h4>"UART Framing"</h4>
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
                                <span class="group-label">"Flow Control"</span>
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
            </aside>
        </div>
    }
}
