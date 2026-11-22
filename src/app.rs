use hotwire_core::protocol::{BoardIdentity, FirmwareMismatch, ToolId};
use hotwire_core::transport::HandshakeGuard;
use hotwire_core::ui::{FirmwareMismatchModal, HotWireTheme};
use leptos::prelude::*;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::buffer::formatters::{append_formatted_chunk, rebuild_formatted_into, ViewMode};
use crate::buffer::ring_buffer::{ChunkDirection, RingBuffer};
use crate::components::bottom_command_bar::BottomCommandBar;
use crate::components::settings_drawer::SettingsDrawer;
use crate::components::terminal_viewport::TerminalViewport;
use crate::components::top_toolbar::TopToolbar;
use crate::protocol::{
    build_get_caps_frame, build_uart_cfg_frame, build_uart_tx_frames, BridgeCapabilities,
    BridgeDemuxer, BridgePacket,
};
use crate::storage::preferences::{
    load_preferences, save_preferences, LineEnding, TerminalMode,
};
use crate::transport::serial::{
    create_terminal_transport, to_core_serial_config, TransportKind, TransportSnapshot,
};

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
    let initial_prefs = load_preferences();
    let serial_transport = StoredValue::new_local(create_terminal_transport(
        &initial_prefs.serial,
        initial_prefs.auto_connect,
    ));
    let transport = RwSignal::new(serial_transport.with_value(|t| t.snapshot()));
    let identity = RwSignal::new(None::<BoardIdentity>);
    let mismatch = RwSignal::new(None::<FirmwareMismatch>);
    let flasher_mismatch = RwSignal::new(None::<FirmwareMismatch>);
    let handshake_guard = StoredValue::new_local(HandshakeGuard::new(ToolId::SerialTerminal));
    let prefs = RwSignal::new(initial_prefs);

    let ring_buffer = StoredValue::new_local(RingBuffer::default());
    let cached_text = StoredValue::new_local(String::with_capacity(4096));
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
    let bridge_demuxer = StoredValue::new_local(BridgeDemuxer::new());
    let was_usb_connected = StoredValue::new_local(false);

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

    let flush_view_now = move || {
        ring_buffer.with_value(|rb| total_bytes.set(rb.total_bytes()));
        cached_text.with_value(|txt| rendered_text.set(txt.clone()));
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
            let _ = win.request_animation_frame(cb.unchecked_ref());
        } else {
            flush_pending.set_value(false);
            flush_view_now();
        }
    };

    let refresh_view = move || {
        let p = prefs.get_untracked();
        ring_buffer.with_value(|rb| {
            let mut next_start = true;
            cached_text.update_value(|buf| {
                next_start = rebuild_formatted_into(
                    buf,
                    rb.chunks(),
                    p.view_mode,
                    p.show_timestamps,
                    p.show_invisible,
                );
            });
            at_line_start.set_value(next_start);
        });
        flush_view_now();
    };

    let push_chunk = move |bytes: &[u8], dir: ChunkDirection| {
        if bytes.is_empty() {
            return;
        }
        let p = prefs.get_untracked();
        ring_buffer.update_value(|rb| {
            let evicted = rb.push(bytes.to_vec(), now_ms(), dir);
            if evicted {
                let mut next_start = true;
                cached_text.update_value(|buf| {
                    next_start = rebuild_formatted_into(
                        buf,
                        rb.chunks(),
                        p.view_mode,
                        p.show_timestamps,
                        p.show_invisible,
                    );
                });
                at_line_start.set_value(next_start);
            } else if let Some(chunk) = rb.last_chunk() {
                let mut start = at_line_start.get_value();
                cached_text.update_value(|buf| {
                    append_formatted_chunk(
                        buf,
                        &mut start,
                        chunk,
                        p.view_mode,
                        p.show_timestamps,
                        p.show_invisible,
                    );
                });
                at_line_start.set_value(start);
            }
        });
        schedule_flush();
    };

    serial_transport.with_value(|st| {
        let initial_p = prefs.get_untracked();
        st.set_init_commands(build_bridge_init_cmds(&initial_p));
        st.init(
            move |snap: TransportSnapshot| {
                let now_connected = snap.status.is_active();
                let is_usb = snap.status.is_usb_connected();
                let dev_name = snap.device_name.clone();
                let prev_usb = was_usb_connected.get_value();
                was_usb_connected.set_value(is_usb);
                transport.set(snap.clone());

                if !now_connected {
                    handshake_guard.update_value(|g| g.cancel());
                    identity.set(None);
                    bridge_caps.set(None);
                    bridge_demuxer.update_value(|d| d.reset());
                } else if !prev_usb && is_usb {
                    let p = prefs.get_untracked();
                    if p.mode == TerminalMode::XiaoUartBridge {
                        mismatch.set(None);
                        flasher_mismatch.set(None);
                        bridge_demuxer.update_value(|d| d.reset());
                        handshake_guard.update_value(|g| {
                            g.arm_timeout(dev_name, 5000, move |mm| {
                                mismatch.set(Some(mm.clone()));
                                flasher_mismatch.set(Some(mm));
                                serial_transport.with_value(|t| t.disconnect());
                            });
                        });
                    } else {
                        handshake_guard.update_value(|g| g.cancel());
                    }
                } else if !is_usb {
                    handshake_guard.update_value(|g| g.cancel());
                    mismatch.set(None);
                    flasher_mismatch.set(None);
                }
            },
            move |bytes: &[u8]| {
                let p = prefs.get_untracked();
                let snap = transport.get_untracked();
                if p.mode == TerminalMode::XiaoUartBridge && snap.transport != TransportKind::Demo {
                    bridge_demuxer.update_value(|d| {
                        d.feed(bytes, |pkt| match pkt {
                            BridgePacket::Capabilities(id, caps) => {
                                serial_transport.with_value(|t| t.notify_handshake_ok());
                                let mut verdict = Ok(());
                                handshake_guard.update_value(|g| {
                                    verdict = g.verify(&id);
                                });
                                if let Err(mm) = verdict {
                                    mismatch.set(Some(mm.clone()));
                                    flasher_mismatch.set(Some(mm));
                                    serial_transport.with_value(|t| t.disconnect());
                                    return;
                                }
                                mismatch.set(None);
                                flasher_mismatch.set(None);
                                if settings_tab.get_untracked() == "flasher" {
                                    settings_open.set(false);
                                }
                                identity.set(Some(id));
                                bridge_caps.set(Some(caps));
                            }
                            BridgePacket::UartRx(data) => {
                                push_chunk(&data, ChunkDirection::Rx);
                            }
                        });
                    });
                } else {
                    push_chunk(bytes, ChunkDirection::Rx);
                }
            },
        );
        let p = prefs.get_untracked();
        st.set_auto_connect(p.auto_connect);
    });

    let connected = Signal::derive(move || transport.get().status.is_active());

    let on_connect = Callback::new(move |_| {
        let p = prefs.get_untracked();
        let cfg = to_core_serial_config(&p.serial, p.auto_connect);
        serial_transport.with_value(|t| t.connect_usb_with_config(cfg));
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
        bridge_demuxer.update_value(|d| d.reset());
        if mode == TerminalMode::DirectUsb {
            handshake_guard.update_value(|g| g.cancel());
            mismatch.set(None);
            flasher_mismatch.set(None);
            identity.set(None);
            bridge_caps.set(None);
            serial_transport
                .with_value(|t| t.reconfigure(to_core_serial_config(&p.serial, p.auto_connect)));
        } else {
            let snap = transport.get_untracked();
            if snap.status.is_usb_connected() {
                let dev_name = snap.device_name.clone();
                mismatch.set(None);
                flasher_mismatch.set(None);
                handshake_guard.update_value(|g| {
                    g.arm_timeout(dev_name, 5000, move |mm| {
                        mismatch.set(Some(mm.clone()));
                        flasher_mismatch.set(Some(mm));
                        serial_transport.with_value(|t| t.disconnect());
                    });
                });
                serial_transport.with_value(|t| t.send_bytes(&init_bytes));
            }
        }
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
        refresh_view();
    });

    let on_save_log = Callback::new(move |_| {
        let txt = rendered_text.get_untracked();
        download_text_file("hotwire-serial-log.txt", &txt);
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
        <HotWireTheme />
        <div class="app-shell">
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
