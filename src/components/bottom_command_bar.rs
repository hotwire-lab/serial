use leptos::prelude::*;

use crate::storage::preferences::{HotWirePreferences, LineEnding, MacroItem};

#[component]
pub fn BottomCommandBar(
    connected: Signal<bool>,
    prefs: RwSignal<HotWirePreferences>,
    on_send_payload: Callback<(String, LineEnding)>,
    on_send_raw: Callback<Vec<u8>>,
    on_set_line_ending: Callback<LineEnding>,
    on_toggle_echo: Callback<()>,
    on_edit_macro: Callback<usize>,
) -> impl IntoView {
    let input_val = RwSignal::new(String::new());
    let cmd_history = StoredValue::new(Vec::<String>::new());
    let hist_idx = StoredValue::new(None::<usize>);

    let submit_cmd = move || {
        if !connected.get_untracked() {
            return;
        }
        let raw = input_val.get_untracked();
        if !raw.is_empty() {
            cmd_history.update_value(|h| {
                if h.last().map(|s| s.as_str()) != Some(&raw) {
                    h.push(raw.clone());
                    if h.len() > 100 {
                        h.remove(0);
                    }
                }
            });
        }
        hist_idx.set_value(None);
        let le = prefs.get_untracked().line_ending;
        on_send_payload.run((raw, le));
        input_val.set(String::new());
    };

    let on_keydown = move |ev: web_sys::KeyboardEvent| {
        let key = ev.key();
        if key == "ArrowUp" {
            ev.prevent_default();
            cmd_history.with_value(|h| {
                if h.is_empty() {
                    return;
                }
                let next = match hist_idx.get_value() {
                    None => h.len() - 1,
                    Some(i) => i.saturating_sub(1),
                };
                hist_idx.set_value(Some(next));
                input_val.set(h[next].clone());
            });
        } else if key == "ArrowDown" {
            ev.prevent_default();
            cmd_history.with_value(|h| {
                if let Some(i) = hist_idx.get_value() {
                    if i + 1 < h.len() {
                        let next = i + 1;
                        hist_idx.set_value(Some(next));
                        input_val.set(h[next].clone());
                    } else {
                        hist_idx.set_value(None);
                        input_val.set(String::new());
                    }
                }
            });
        }
    };

    view! {
        <footer class="command-bar">
            <div class="macro-row">
                <div class="inline-controls">
                    <button
                        type="button"
                        class="btn btn-xs btn-secondary"
                        disabled=move || !connected.get()
                        on:click=move |_| on_send_raw.run(vec![0x03])
                        title="Send Ctrl+C (0x03)"
                    >
                        "Ctrl+C"
                    </button>
                    <button
                        type="button"
                        class="btn btn-xs btn-secondary"
                        disabled=move || !connected.get()
                        on:click=move |_| on_send_raw.run(vec![0x1b])
                        title="Send ESC (0x1B)"
                    >
                        "ESC"
                    </button>
                    <button
                        type="button"
                        class="btn btn-xs btn-secondary"
                        disabled=move || !connected.get()
                        on:click=move |_| on_send_raw.run(vec![b'\t'])
                        title="Send TAB (0x09)"
                    >
                        "TAB"
                    </button>
                </div>

                <div class="control-divider-sm" />

                <div class="macro-chips">
                    {move || {
                        prefs
                            .get()
                            .macros
                            .into_iter()
                            .enumerate()
                            .map(|(idx, m): (usize, MacroItem)| {
                                let payload = m.payload.clone();
                                let le = m.line_ending;
                                view! {
                                    <button
                                        type="button"
                                        class="macro-chip"
                                        disabled=move || !connected.get()
                                        on:click=move |_| on_send_payload.run((payload.clone(), le))
                                        on:contextmenu=move |ev| {
                                            ev.prevent_default();
                                            on_edit_macro.run(idx);
                                        }
                                        title="Click to send · Right-click to edit"
                                    >
                                        {m.label}
                                    </button>
                                }
                            })
                            .collect_view()
                    }}
                </div>
            </div>

            <form
                class="command-input-row"
                on:submit=move |ev| {
                    ev.prevent_default();
                    submit_cmd();
                }
            >
                <input
                    type="text"
                    class="cmd-input"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    enterkeyhint="send"
                    placeholder=move || {
                        if connected.get() {
                            "Type serial command (↑/↓ history)..."
                        } else {
                            "Connect USB or start Demo to send commands"
                        }
                    }
                    disabled=move || !connected.get()
                    prop:value=move || input_val.get()
                    on:input=move |ev| input_val.set(event_target_value(&ev))
                    on:keydown=on_keydown
                />

                <select
                    class="ctrl-select ctrl-select-sm"
                    aria-label="Line ending"
                    prop:value=move || prefs.get().line_ending.as_str()
                    on:change=move |ev| {
                        on_set_line_ending.run(LineEnding::from_str(&event_target_value(&ev)));
                    }
                >
                    <option value="CRLF">"CRLF"</option>
                    <option value="LF">"LF"</option>
                    <option value="CR">"CR"</option>
                    <option value="RAW">"RAW"</option>
                </select>

                <button
                    type="button"
                    class=move || if prefs.get().local_echo { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                    on:click=move |_| on_toggle_echo.run(())
                    title="Toggle Local Echo"
                >
                    "Echo"
                </button>

                <button
                    type="submit"
                    class="btn btn-primary"
                    disabled=move || !connected.get()
                >
                    "Send"
                </button>
            </form>
        </footer>
    }
}
