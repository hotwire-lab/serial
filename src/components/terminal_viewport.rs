use leptos::html;
use leptos::prelude::*;

use crate::buffer::formatters::ViewMode;
use crate::storage::preferences::HotWirePreferences;

#[component]
#[allow(clippy::too_many_arguments)]
pub fn TerminalViewport(
    rendered_text: RwSignal<String>,
    total_bytes: RwSignal<usize>,
    prefs: RwSignal<HotWirePreferences>,
    auto_scroll: RwSignal<bool>,
    on_set_view_mode: Callback<ViewMode>,
    on_toggle_timestamps: Callback<()>,
    on_toggle_invisible: Callback<()>,
    on_change_font: Callback<i8>,
    on_clear: Callback<()>,
    on_save_log: Callback<()>,
) -> impl IntoView {
    let pre_ref = NodeRef::<html::Pre>::new();

    Effect::new(move |_| {
        let _ = rendered_text.get();
        if auto_scroll.get_untracked() {
            if let Some(el) = pre_ref.get() {
                el.set_scroll_top(el.scroll_height());
            }
        }
    });

    let on_scroll = move |_| {
        if let Some(el) = pre_ref.get_untracked() {
            let at_bottom = el.scroll_height() - el.scroll_top() - el.client_height() <= 24;
            if auto_scroll.get_untracked() != at_bottom {
                auto_scroll.set(at_bottom);
            }
        }
    };

    let on_wheel = move |ev: web_sys::WheelEvent| {
        if ev.ctrl_key() {
            ev.prevent_default();
            on_change_font.run(if ev.delta_y() < 0.0 { 1 } else { -1 });
        }
    };

    view! {
        <section class="terminal-section">
            <div class="control-bar terminal-subbar">
                <div class="inline-controls">
                    <button
                        type="button"
                        class=move || if prefs.get().view_mode == ViewMode::Ascii { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                        on:click=move |_| on_set_view_mode.run(ViewMode::Ascii)
                    >
                        "ASCII"
                    </button>
                    <button
                        type="button"
                        class=move || if prefs.get().view_mode == ViewMode::Hex { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                        on:click=move |_| on_set_view_mode.run(ViewMode::Hex)
                    >
                        "HEX"
                    </button>
                    <button
                        type="button"
                        class=move || if prefs.get().show_timestamps { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                        on:click=move |_| on_toggle_timestamps.run(())
                    >
                        "Time"
                    </button>
                    <button
                        type="button"
                        class=move || if prefs.get().show_invisible { "btn btn-sm btn-accent active" } else { "btn btn-sm btn-secondary" }
                        on:click=move |_| on_toggle_invisible.run(())
                        title="Show CR/LF/Tab/Space glyphs"
                    >
                        "Ctrl"
                    </button>
                </div>

                <div class="control-spacer" />

                <div class="inline-controls">
                    <span class="mono-muted">
                        {move || {
                            let b = total_bytes.get();
                            if b >= 1024 {
                                format!("{:.1} KB", b as f64 / 1024.0)
                            } else {
                                format!("{b} B")
                            }
                        }}
                    </span>
                    <button
                        type="button"
                        class="btn btn-sm btn-secondary"
                        on:click=move |_| on_change_font.run(-1)
                        title="Decrease font size"
                    >
                        "A−"
                    </button>
                    <button
                        type="button"
                        class="btn btn-sm btn-secondary"
                        on:click=move |_| on_change_font.run(1)
                        title="Increase font size"
                    >
                        "A+"
                    </button>
                    <button
                        type="button"
                        class="btn btn-sm btn-secondary"
                        on:click=move |_| on_save_log.run(())
                    >
                        "Save Log"
                    </button>
                    <button
                        type="button"
                        class="btn btn-sm btn-ghost"
                        on:click=move |_| on_clear.run(())
                    >
                        "Clear"
                    </button>
                </div>
            </div>

            <div class="terminal-viewport-wrap">
                <pre
                    node_ref=pre_ref
                    class="terminal-viewport"
                    style=move || format!("font-size: {}px;", prefs.get().font_size)
                    on:scroll=on_scroll
                    on:wheel=on_wheel
                >
                    {move || {
                        let txt = rendered_text.get();
                        if txt.is_empty() {
                            "HotWire Serial Terminal ready. Click 'Connect USB' or 'Demo' to begin.\n".to_string()
                        } else {
                            txt
                        }
                    }}
                </pre>

                {move || {
                    if !auto_scroll.get() {
                        Some(view! {
                            <button
                                type="button"
                                class="btn btn-sm btn-primary resume-scroll-btn"
                                on:click=move |_| {
                                    auto_scroll.set(true);
                                    if let Some(el) = pre_ref.get_untracked() {
                                        el.set_scroll_top(el.scroll_height());
                                    }
                                }
                            >
                                "↓ Resume Scroll"
                            </button>
                        })
                    } else {
                        None
                    }
                }}
            </div>
        </section>
    }
}
