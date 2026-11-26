use std::collections::VecDeque;

use hotwire_core::protocol::{FrameRule, ToolId};
use hotwire_core::ui::{FirmwareMismatchModal, HotWireTheme};
use hotwire_core::web::{download_text_file, now_ms};
use hotwire_core::{use_hotwire_session, SessionConfig};
use leptos::prelude::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::buffer::formatters::{append_formatted_chunk, ViewMode};
use crate::buffer::ring_buffer::{ChunkDirection, RingBuffer};
use crate::components::bottom_command_bar::BottomCommandBar;
use crate::components::settings_drawer::SettingsDrawer;
use crate::components::terminal_viewport::TerminalViewport;
use crate::components::top_toolbar::TopToolbar;
use crate::protocol::{
    build_get_caps_frame, build_uart_cfg_frame, build_uart_tx_frames, BridgeCapabilities,
    TYPE_UART_RX,
};
use crate::storage::preferences::{load_preferences, save_preferences, LineEnding, TerminalMode};
use crate::transport::serial::{create_terminal_transport, to_core_serial_config, TransportKind};

/// Splits bytes into a complete UTF-8 prefix and an incomplete trailing
/// sequence that should be carried into the next USB chunk.
/// Maximum number of formatted characters rendered into the DOM. The full
/// ring buffer remains available for export, but rendering a multi-megabyte
/// string at 20 fps is unnecessarily expensive on mobile devices.
const MAX_RENDER_CHARS: usize = 256 * 1024;

fn tail_chars(text: &str, max_chars: usize) -> &str {
    if text.len() <= max_chars {
        return text;
    }
    let mut start = text.len() - max_chars;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn split_utf8_tail(data: &[u8]) -> (usize, Vec<u8>) {
    match std::str::from_utf8(data) {
        Ok(_) => (data.len(), Vec::new()),
        Err(err) if err.error_len().is_none() => {
            let split = err.valid_up_to();
            (split, data[split..].to_vec())
        }
        Err(_) => (data.len(), Vec::new()),
    }
}

#[component]
pub fn App() -> impl IntoView {
    let initial_prefs = load_preferences();
    let serial_transport = StoredValue::new_local(create_terminal_transport(
        &initial_prefs.serial,
        initial_prefs.auto_connect,
    ));
    let prefs = RwSignal::new(initial_prefs);

    let ring_buffer = StoredValue::new_local(RingBuffer::default());
    let cached_text = StoredValue::new_local(String::with_capacity(4096));
    let formatted_lens = StoredValue::new_local(VecDeque::<usize>::new());
    let pending_trim_chars = StoredValue::new(0usize);
    let utf8_carry = StoredValue::new_local(Vec::<u8>::new());
    let at_line_start = StoredValue::new(true);
    let flush_pending = StoredValue::new(false);
    let rendered_text = RwSignal::new(String::new());
    let total_bytes = RwSignal::new(0usize);
    let auto_scroll = RwSignal::new(true);
    let subbar_open = RwSignal::new(false);
    let settings_open = RwSignal::new(false);
    let settings_tab = RwSignal::new("settings".to_string());
    let editing_macro_idx = RwSignal::new(None::<usize>);
    let bridge_caps = RwSignal::new(None::<BridgeCapabilities>);

    let build_bridge_init_cmds = |p: &crate::storage::preferences::HotWirePreferences| -> Vec<u8> {
        if p.mode == TerminalMode::XiaoUartBridge {
            let mut init_bytes = build_get_caps_frame();
            init_bytes.extend_from_slice(&build_uart_cfg_frame(
                p.serial.baud_rate,
                p.serial.data_bits,
                p.serial.stop_bits,
                p.serial.parity,
                p.bridge_swap_pins,
                p.bridge_invert_rx,
                p.bridge_invert_tx,
            ));
            init_bytes
        } else {
            Vec::new()
        }
    };

    let needs_rebuild = StoredValue::new_local(false);

    let rebuild_cache = move || {
        let p = prefs.get_untracked();
        ring_buffer.with_value(|rb| {
            let mut lens = VecDeque::new();
            let mut next_start = true;
            cached_text.update_value(|buf| {
                buf.clear();
                let mut start = true;
                for chunk in rb.chunks() {
                    let before = buf.len();
                    append_formatted_chunk(
                        buf,
                        &mut start,
                        chunk,
                        p.view_mode,
                        p.show_timestamps,
                        p.show_invisible,
                    );
                    lens.push_back(buf.len() - before);
                }
                next_start = start;
            });
            formatted_lens.set_value(lens);
            pending_trim_chars.set_value(0);
            at_line_start.set_value(next_start);
            needs_rebuild.set_value(false);
        });
    };

    let flush_view_now = move || {
        if needs_rebuild.get_value() {
            needs_rebuild.set_value(false);
            rebuild_cache();
        }
        ring_buffer.with_value(|rb| total_bytes.set(rb.total_bytes()));
        cached_text
            .with_value(|txt| rendered_text.set(tail_chars(txt, MAX_RENDER_CHARS).to_string()));
    };

    let schedule_flush = move || {
        if flush_pending.get_value() {
            return;
        }
        flush_pending.set_value(true);
        if let Some(win) = web_sys::window() {
            let cb = Closure::once_into_js(move || {
                flush_pending.set_value(false);
                flush_view_now();
            });
            // Cap UI text updates at ~20 fps; at high baud rates a full
            // viewport clone on every animation frame is unnecessarily costly.
            if win
                .set_timeout_with_callback_and_timeout_and_arguments_0(cb.unchecked_ref(), 50)
                .is_err()
            {
                flush_pending.set_value(false);
                flush_view_now();
            }
        } else {
            flush_pending.set_value(false);
            flush_view_now();
        }
    };

    let refresh_view = move || {
        rebuild_cache();
        flush_view_now();
    };

    let push_chunk = move |bytes: &[u8], dir: ChunkDirection| {
        if bytes.is_empty() {
            return;
        }
        let p = prefs.get_untracked();
        let (valid_len, buffer) = if p.view_mode == ViewMode::Ascii {
            let mut combined = utf8_carry.get_value();
            combined.extend_from_slice(bytes);
            let (split, tail) = split_utf8_tail(&combined);
            utf8_carry.set_value(tail);
            (split, combined)
        } else {
            let mut combined = utf8_carry.get_value();
            utf8_carry.set_value(Vec::new());
            combined.extend_from_slice(bytes);
            (combined.len(), combined)
        };
        if valid_len == 0 {
            return;
        }
        let bytes = &buffer[..valid_len];
        ring_buffer.update_value(|rb| {
            let evicted = rb.push(bytes.to_vec(), now_ms(), dir);
            if needs_rebuild.get_value() {
                return;
            }

            let mut trim_chars = 0usize;
            if evicted > 0 {
                let available = formatted_lens.with_value(|lens| lens.len());
                if available < evicted {
                    // Formatting state is incomplete (e.g. a view change is
                    // pending); rebuild from the ring buffer on next flush.
                    needs_rebuild.set_value(true);
                    return;
                }
                formatted_lens.update_value(|lens| {
                    for _ in 0..evicted {
                        trim_chars += lens.pop_front().unwrap_or(0);
                    }
                });
            }

            if let Some(chunk) = rb.last_chunk() {
                let mut start = at_line_start.get_value();
                let mut appended_len = 0usize;
                cached_text.update_value(|buf| {
                    let before = buf.len();
                    append_formatted_chunk(
                        buf,
                        &mut start,
                        chunk,
                        p.view_mode,
                        p.show_timestamps,
                        p.show_invisible,
                    );
                    appended_len = buf.len() - before;
                });
                at_line_start.set_value(start);
                formatted_lens.update_value(|lens| lens.push_back(appended_len));
            }

            if trim_chars > 0 {
                pending_trim_chars.set_value(pending_trim_chars.get_value() + trim_chars);
                let pending = pending_trim_chars.get_value();
                if pending >= 64 * 1024 {
                    let mut removed = 0usize;
                    cached_text.update_value(|buf| {
                        let mut n = pending.min(buf.len());
                        while n > 0 && !buf.is_char_boundary(n) {
                            n -= 1;
                        }
                        buf.drain(..n);
                        removed = n;
                    });
                    pending_trim_chars.set_value(pending.saturating_sub(removed));
                }
            }
        });
        schedule_flush();
    };

    let initial_p = prefs.get_untracked();
    let mut session_config = SessionConfig::new(
        ToolId::SerialTerminal,
        vec![FrameRule::new(TYPE_UART_RX, 0, 4096)],
    );
    session_config.handshake_enabled = initial_p.mode == TerminalMode::XiaoUartBridge;
    session_config.demux_enabled = initial_p.mode == TerminalMode::XiaoUartBridge;

    let session = use_hotwire_session(
        serial_transport.with_value(|t| t.clone()),
        session_config,
        move |id, _is_usb| {
            if let Ok(caps) = serde_json::from_value::<BridgeCapabilities>(id.raw.clone()) {
                bridge_caps.set(Some(caps));
            }
            if settings_tab.get_untracked() == "flasher" {
                settings_open.set(false);
            }
        },
        move || {
            bridge_caps.set(None);
            utf8_carry.set_value(Vec::new());
        },
        move |frame_type, payload| {
            let p = prefs.get_untracked();
            if p.mode == TerminalMode::XiaoUartBridge && frame_type == TYPE_UART_RX {
                push_chunk(payload, ChunkDirection::Rx);
            }
        },
        move |text| {
            let p = prefs.get_untracked();
            if p.mode == TerminalMode::DirectUsb {
                push_chunk(text, ChunkDirection::Rx);
            }
        },
    );
    let transport = session.transport;
    let identity = session.identity;
    let mismatch = session.mismatch;
    let flasher_mismatch = session.flasher_mismatch;
    let session_store = StoredValue::new_local(session);
    serial_transport.with_value(|t| t.set_auto_connect(initial_p.auto_connect));

    let connected = Signal::derive(move || transport.get().status.is_active());

    let on_connect = Callback::new(move |_| {
        let p = prefs.get_untracked();
        let cfg = to_core_serial_config(&p.serial, p.auto_connect);
        serial_transport.with_value(|t| {
            t.set_init_commands(build_bridge_init_cmds(&p));
            t.connect_usb_with_config(cfg);
        });
    });

    let on_disconnect = Callback::new(move |_| {
        serial_transport.with_value(|t| t.disconnect());
    });

    let on_start_demo = Callback::new(move |_| {
        serial_transport.with_value(|t| t.start_demo());
    });

    let send_bridge_uart_cfg = move || {
        let snap = transport.get_untracked();
        let p = prefs.get_untracked();
        serial_transport.with_value(|t| t.set_init_commands(build_bridge_init_cmds(&p)));
        if snap.status.is_active()
            && snap.transport != TransportKind::Demo
            && p.mode == TerminalMode::XiaoUartBridge
        {
            let frame = build_uart_cfg_frame(
                p.serial.baud_rate,
                p.serial.data_bits,
                p.serial.stop_bits,
                p.serial.parity,
                p.bridge_swap_pins,
                p.bridge_invert_rx,
                p.bridge_invert_tx,
            );
            serial_transport.with_value(|t| t.send_bytes(&frame));
        }
    };

    let on_mode_change = Callback::new(move |mode: TerminalMode| {
        prefs.update(|p| {
            p.mode = mode;
            save_preferences(p);
        });
        let p = prefs.get_untracked();
        let init_bytes = build_bridge_init_cmds(&p);
        serial_transport.with_value(|t| t.set_init_commands(init_bytes.clone()));
        session_store.with_value(|session| {
            session.clear_identity();
            session.set_demux_enabled(mode == TerminalMode::XiaoUartBridge);
            session.set_handshake_enabled(mode == TerminalMode::XiaoUartBridge);
            session.cancel_handshake();
            bridge_caps.set(None);
            if mode == TerminalMode::DirectUsb {
                serial_transport.with_value(|t| {
                    t.reconfigure(to_core_serial_config(&p.serial, p.auto_connect));
                });
            } else {
                let snap = transport.get_untracked();
                if snap.status.is_usb_connected() {
                    session.arm_handshake(snap.device_name.clone());
                    serial_transport.with_value(|t| t.send_bytes(&init_bytes));
                }
            }
        });
    });

    let on_toggle_auto_connect = Callback::new(move |_| {
        prefs.update(|p| {
            p.auto_connect = !p.auto_connect;
            save_preferences(p);
        });
        let p = prefs.get_untracked();
        serial_transport.with_value(|t| t.set_auto_connect(p.auto_connect));
    });

    let on_baud_change = Callback::new(move |baud: u32| {
        prefs.update(|p| {
            p.serial.baud_rate = baud;
            save_preferences(p);
        });
        let p = prefs.get_untracked();
        if p.mode == TerminalMode::XiaoUartBridge {
            send_bridge_uart_cfg();
        } else {
            serial_transport
                .with_value(|t| t.reconfigure(to_core_serial_config(&p.serial, p.auto_connect)));
        }
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
        utf8_carry.set_value(Vec::new());
        formatted_lens.set_value(VecDeque::new());
        pending_trim_chars.set_value(0);
        refresh_view();
    });

    let on_save_log = Callback::new(move |_| {
        let txt = rendered_text.get_untracked();
        download_text_file("hotwire-serial-log.txt", &txt, "text/plain;charset=utf-8");
    });

    let send_tx = move |bytes: &[u8]| {
        let p = prefs.get_untracked();
        let snap = transport.get_untracked();
        if p.mode == TerminalMode::XiaoUartBridge && snap.transport != TransportKind::Demo {
            let framed = build_uart_tx_frames(bytes);
            serial_transport.with_value(|t| t.send_bytes(&framed));
        } else {
            serial_transport.with_value(|t| t.send_bytes(bytes));
        }
    };

    let on_send_payload = Callback::new(move |(payload, le): (String, LineEnding)| {
        let full = format!("{payload}{}", le.suffix());
        let bytes = full.as_bytes();
        if prefs.get_untracked().local_echo {
            push_chunk(bytes, ChunkDirection::Tx);
        }
        send_tx(bytes);
    });

    let on_send_raw = Callback::new(move |bytes: Vec<u8>| {
        send_tx(&bytes);
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
        settings_open.set(true);
    });

    let on_close_settings = Callback::new(move |_| settings_open.set(false));

    let on_open_flasher = Callback::new(move |_| {
        mismatch.set(None);
        editing_macro_idx.set(None);
        settings_tab.set("flasher".to_string());
        settings_open.set(true);
    });

    let on_toggle_flasher = Callback::new(move |_| {
        editing_macro_idx.set(None);
        if settings_open.get_untracked() && settings_tab.get_untracked() == "flasher" {
            settings_open.set(false);
        } else {
            settings_tab.set("flasher".to_string());
            settings_open.set(true);
        }
    });

    let on_update_serial_cfg = Callback::new(move |(db, sb, par, fc): (u8, u8, u8, u8)| {
        prefs.update(|p| {
            p.serial.data_bits = db;
            p.serial.stop_bits = sb;
            p.serial.parity = par;
            p.serial.flow_control = fc;
            save_preferences(p);
        });
        let p = prefs.get_untracked();
        if p.mode == TerminalMode::XiaoUartBridge {
            send_bridge_uart_cfg();
        } else {
            serial_transport
                .with_value(|t| t.reconfigure(to_core_serial_config(&p.serial, p.auto_connect)));
        }
    });

    let on_update_bridge_flags =
        Callback::new(move |(swap, inv_rx, inv_tx): (bool, bool, bool)| {
            prefs.update(|p| {
                p.bridge_swap_pins = swap;
                p.bridge_invert_rx = inv_rx;
                p.bridge_invert_tx = inv_tx;
                save_preferences(p);
            });
            send_bridge_uart_cfg();
        });

    let on_save_macro = Callback::new(
        move |(idx, label, payload, le): (usize, String, String, LineEnding)| {
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
        },
    );

    view! {
        <HotWireTheme />
        <div class="app-shell hw-app">
            <TopToolbar
                transport=transport
                identity=identity
                prefs=prefs
                bridge_caps=bridge_caps
                subbar_open=subbar_open
                settings_open=settings_open
                settings_tab=settings_tab
                on_connect=on_connect
                on_disconnect=on_disconnect
                on_start_demo=on_start_demo
                on_mode_change=on_mode_change
                on_baud_change=on_baud_change
                on_toggle_auto_connect=on_toggle_auto_connect
                on_toggle_dtr=on_toggle_dtr
                on_toggle_rts=on_toggle_rts
                on_pulse_rst=on_pulse_rst
                on_switch_port=on_switch_port
                on_toggle_flasher=on_toggle_flasher
            />

            <main class="serial-main">
                <TerminalViewport
                    rendered_text=rendered_text
                    total_bytes=total_bytes
                    prefs=prefs
                    auto_scroll=auto_scroll
                    subbar_open=subbar_open
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
                active_tab=settings_tab
                transport=transport
                identity=identity
                mismatch=flasher_mismatch
                prefs=prefs
                editing_macro_idx=editing_macro_idx
                serial_transport=serial_transport
                on_close=on_close_settings
                on_mode_change=on_mode_change
                on_baud_change=on_baud_change
                on_toggle_auto_connect=on_toggle_auto_connect
                on_toggle_dtr=on_toggle_dtr
                on_toggle_rts=on_toggle_rts
                on_pulse_rst=on_pulse_rst
                on_switch_port=on_switch_port
                on_update_serial_cfg=on_update_serial_cfg
                on_update_bridge_flags=on_update_bridge_flags
                on_save_macro=on_save_macro
            />

            <FirmwareMismatchModal
                mismatch=mismatch
                on_open_flasher=on_open_flasher
            />
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::{split_utf8_tail, tail_chars};

    #[test]
    fn carries_split_utf8_sequences() {
        let bytes = "Moi ä".as_bytes();
        let (valid, tail) = split_utf8_tail(&bytes[..bytes.len() - 1]);
        assert_eq!(valid, "Moi ".len());
        assert_eq!(tail, &bytes[4..5]);

        let (valid, tail) = split_utf8_tail(bytes);
        assert_eq!(valid, bytes.len());
        assert!(tail.is_empty());
    }

    #[test]
    fn tail_chars_never_splits_utf8() {
        let text = format!("{}ä", "x".repeat(32));
        let tail = tail_chars(&text, 4);
        assert!(tail.ends_with('ä'));
        assert!(text.ends_with(tail));
        assert_eq!(tail_chars("short", 64), "short");
    }
}
