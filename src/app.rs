use leptos::prelude::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::buffer::formatters::{format_chunks, ViewMode};
use crate::buffer::ring_buffer::{ChunkDirection, RingBuffer};
use crate::components::bottom_command_bar::BottomCommandBar;
use crate::components::settings_drawer::SettingsDrawer;
use crate::components::terminal_viewport::TerminalViewport;
use crate::components::top_toolbar::TopToolbar;
use crate::storage::preferences::{
    load_preferences, save_preferences, LineEnding,
};
use crate::transport::serial::{ConnectionStatus, SerialTransport, TransportSnapshot};

fn now_ms() -> u64 {
    js_sys::Date::now() as u64
}

fn download_text_file(filename: &str, content: &str) {
    let Some(win) = web_sys::window() else { return };
    let Some(doc) = win.document() else { return };
    let arr = js_sys::Array::new();
    arr.push(&content.into());
    let bag = web_sys::BlobPropertyBag::new();
    bag.set_type("text/plain;charset=utf-8");
    let Ok(blob) = web_sys::Blob::new_with_str_sequence_and_options(&arr, &bag) else {
        return;
    };
    let Ok(url) = web_sys::Url::create_object_url_with_blob(&blob) else {
        return;
    };
    if let Ok(el) = doc.create_element("a") {
        if let Ok(link) = el.dyn_into::<web_sys::HtmlAnchorElement>() {
            link.set_href(&url);
            link.set_download(filename);
            if let Some(body) = doc.body() {
                let _ = body.append_child(&link);
                link.click();
                link.remove();
            }
        }
    }
    let url_clone = url.clone();
    let cb = Closure::once(move || {
        let _ = web_sys::Url::revoke_object_url(&url_clone);
    });
    let _ = win.set_timeout_with_callback_and_timeout_and_arguments_0(
        cb.as_ref().unchecked_ref(),
        1000,
    );
    cb.forget();
}

#[component]
pub fn App() -> impl IntoView {
    let serial_transport = StoredValue::new_local(SerialTransport::new());
    let transport = RwSignal::new(serial_transport.with_value(|t| t.snapshot()));
    let prefs = RwSignal::new(load_preferences());

    let ring_buffer = StoredValue::new_local(RingBuffer::default());
    let rendered_text = RwSignal::new(String::new());
    let total_bytes = RwSignal::new(0usize);
    let auto_scroll = RwSignal::new(true);
    let settings_open = RwSignal::new(false);
    let editing_macro_idx = RwSignal::new(None::<usize>);

    let refresh_view = move || {
        let p = prefs.get_untracked();
        ring_buffer.with_value(|rb| {
            total_bytes.set(rb.total_bytes());
            rendered_text.set(format_chunks(
                rb.chunks(),
                p.view_mode,
                p.show_timestamps,
                p.show_invisible,
            ));
        });
    };

    let push_chunk = move |bytes: &[u8], dir: ChunkDirection| {
        if bytes.is_empty() {
            return;
        }
        ring_buffer.update_value(|rb| {
            rb.push(bytes.to_vec(), now_ms(), dir);
        });
        refresh_view();
    };

    serial_transport.with_value(|st| {
        st.init(
            move |snap: TransportSnapshot| {
                transport.set(snap);
            },
            move |bytes: &[u8]| {
                push_chunk(bytes, ChunkDirection::Rx);
            },
        );
    });

    let connected = Signal::derive(move || transport.get().status == ConnectionStatus::Connected);

    let on_connect = Callback::new(move |_| {
        let cfg = prefs.get_untracked().serial;
        serial_transport.with_value(|t| t.connect(&cfg));
    });

    let on_disconnect = Callback::new(move |_| {
        serial_transport.with_value(|t| t.disconnect());
    });

    let on_start_demo = Callback::new(move |_| {
        serial_transport.with_value(|t| t.start_demo());
    });

    let on_baud_change = Callback::new(move |baud: u32| {
        prefs.update(|p| {
            p.serial.baud_rate = baud;
            save_preferences(p);
        });
        let cfg = prefs.get_untracked().serial;
        serial_transport.with_value(|t| t.reconfigure(&cfg));
    });

    let on_toggle_dtr = Callback::new(move |_| {
        let snap = transport.get_untracked();
        serial_transport.with_value(|t| t.set_signals(!snap.dtr, snap.rts));
    });

    let on_toggle_rts = Callback::new(move |_| {
        let snap = transport.get_untracked();
        serial_transport.with_value(|t| t.set_signals(snap.dtr, !snap.rts));
    });

    let on_pulse_rst = Callback::new(move |_| {
        serial_transport.with_value(|t| t.pulse_reset());
    });

    let on_switch_port = Callback::new(move |idx: u32| {
        serial_transport.with_value(|t| t.switch_usb_port(idx));
    });

    let on_set_view_mode = Callback::new(move |mode: ViewMode| {
        prefs.update(|p| {
            p.view_mode = mode;
            save_preferences(p);
        });
        refresh_view();
    });

    let on_toggle_timestamps = Callback::new(move |_| {
        prefs.update(|p| {
            p.show_timestamps = !p.show_timestamps;
            save_preferences(p);
        });
        refresh_view();
    });

    let on_toggle_invisible = Callback::new(move |_| {
        prefs.update(|p| {
            p.show_invisible = !p.show_invisible;
            save_preferences(p);
        });
        refresh_view();
    });

    let on_change_font = Callback::new(move |delta: i8| {
        prefs.update(|p| {
            let next = (p.font_size as i16 + delta as i16).clamp(9, 24) as u8;
            p.font_size = next;
            save_preferences(p);
        });
    });

    let on_clear = Callback::new(move |_| {
        ring_buffer.update_value(|rb| rb.clear());
        refresh_view();
    });

    let on_save_log = Callback::new(move |_| {
        let txt = rendered_text.get_untracked();
        download_text_file("hotwire-serial-log.txt", &txt);
    });

    let on_send_payload = Callback::new(move |(payload, le): (String, LineEnding)| {
        let full = format!("{payload}{}", le.suffix());
        let bytes = full.as_bytes();
        if prefs.get_untracked().local_echo {
            push_chunk(bytes, ChunkDirection::Tx);
        }
        serial_transport.with_value(|t| t.send_bytes(bytes));
    });

    let on_send_raw = Callback::new(move |bytes: Vec<u8>| {
        serial_transport.with_value(|t| t.send_bytes(&bytes));
    });

    let on_set_line_ending = Callback::new(move |le: LineEnding| {
        prefs.update(|p| {
            p.line_ending = le;
            save_preferences(p);
        });
    });

    let on_toggle_echo = Callback::new(move |_| {
        prefs.update(|p| {
            p.local_echo = !p.local_echo;
            save_preferences(p);
        });
    });

    let on_edit_macro = Callback::new(move |idx: usize| {
        editing_macro_idx.set(Some(idx));
    });

    let on_close_settings = Callback::new(move |_| settings_open.set(false));

    let on_update_serial_cfg = Callback::new(move |(db, sb, par, fc): (u8, u8, u8, u8)| {
        prefs.update(|p| {
            p.serial.data_bits = db;
            p.serial.stop_bits = sb;
            p.serial.parity = par;
            p.serial.flow_control = fc;
            save_preferences(p);
        });
        let cfg = prefs.get_untracked().serial;
        serial_transport.with_value(|t| t.reconfigure(&cfg));
    });

    let on_save_macro =
        Callback::new(move |(idx, label, payload, le): (usize, String, String, LineEnding)| {
            prefs.update(|p| {
                if let Some(m) = p.macros.get_mut(idx) {
                    if !label.trim().is_empty() {
                        m.label = label.trim().to_string();
                    }
                    m.payload = payload;
                    m.line_ending = le;
                    save_preferences(p);
                }
            });
        });

    view! {
        <div class="app-shell">
            <TopToolbar
                transport=transport
                prefs=prefs
                settings_open=settings_open
                on_connect=on_connect
                on_disconnect=on_disconnect
                on_start_demo=on_start_demo
                on_baud_change=on_baud_change
                on_toggle_dtr=on_toggle_dtr
                on_toggle_rts=on_toggle_rts
                on_pulse_rst=on_pulse_rst
                on_switch_port=on_switch_port
            />

            <main class="serial-main">
                <TerminalViewport
                    rendered_text=rendered_text
                    total_bytes=total_bytes
                    prefs=prefs
                    auto_scroll=auto_scroll
                    on_set_view_mode=on_set_view_mode
                    on_toggle_timestamps=on_toggle_timestamps
                    on_toggle_invisible=on_toggle_invisible
                    on_change_font=on_change_font
                    on_clear=on_clear
                    on_save_log=on_save_log
                />
            </main>

            <BottomCommandBar
                connected=connected
                prefs=prefs
                on_send_payload=on_send_payload
                on_send_raw=on_send_raw
                on_set_line_ending=on_set_line_ending
                on_toggle_echo=on_toggle_echo
                on_edit_macro=on_edit_macro
            />

            <SettingsDrawer
                open=settings_open
                prefs=prefs
                editing_macro_idx=editing_macro_idx
                on_close=on_close_settings
                on_update_serial_cfg=on_update_serial_cfg
                on_save_macro=on_save_macro
            />
        </div>
    }
}
