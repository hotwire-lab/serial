use std::cell::RefCell;
use std::rc::Rc;

use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

use crate::storage::preferences::SerialPortConfig;
use crate::transport::demo::DemoShell;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    None,
    WebSerial,
    WebUsb,
    Demo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionStatus {
    Waiting,
    Connecting,
    Connected,
}

impl ConnectionStatus {
    pub fn as_class(&self) -> &'static str {
        match self {
            ConnectionStatus::Waiting => "waiting",
            ConnectionStatus::Connecting => "connecting",
            ConnectionStatus::Connected => "connected",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportSnapshot {
    pub status: ConnectionStatus,
    pub transport: TransportKind,
    pub device_name: String,
    pub vid_pid: String,
    pub port_index: u32,
    pub port_count: u32,
    pub dtr: bool,
    pub rts: bool,
    pub error_message: Option<String>,
}

impl Default for TransportSnapshot {
    fn default() -> Self {
        Self {
            status: ConnectionStatus::Waiting,
            transport: TransportKind::None,
            device_name: "Waiting for USB...".to_string(),
            vid_pid: String::new(),
            port_index: 0,
            port_count: 0,
            dtr: false,
            rts: false,
            error_message: None,
        }
    }
}

#[wasm_bindgen(module = "/js/web_serial_bridge.js")]
extern "C" {
    fn js_init_serial(on_state: &js_sys::Function, on_bytes: &js_sys::Function);
    fn js_connect_serial(
        baud_rate: u32,
        data_bits: u8,
        stop_bits: u8,
        parity: u8,
        flow_control: u8,
    ) -> js_sys::Promise;
    fn js_disconnect_serial() -> js_sys::Promise;
    fn js_write_serial(bytes: &[u8]) -> js_sys::Promise;
    fn js_set_signals(dtr: bool, rts: bool) -> js_sys::Promise;
    fn js_pulse_reset() -> js_sys::Promise;
    fn js_reconfigure_serial(
        baud_rate: u32,
        data_bits: u8,
        stop_bits: u8,
        parity: u8,
        flow_control: u8,
    ) -> js_sys::Promise;
    fn js_switch_usb_port(port_idx: u32) -> js_sys::Promise;
}

type StateCallback = Rc<RefCell<Option<Box<dyn FnMut(TransportSnapshot)>>>>;
type BytesCallback = Rc<RefCell<Option<Box<dyn FnMut(&[u8])>>>>;
type DemoClosureSlot = Rc<RefCell<Option<Closure<dyn FnMut()>>>>;

#[derive(Clone)]
pub struct SerialTransport {
    snapshot: Rc<RefCell<TransportSnapshot>>,
    demo: Rc<RefCell<DemoShell>>,
    demo_timer_id: Rc<RefCell<Option<i32>>>,
    demo_closure: DemoClosureSlot,
    on_state: StateCallback,
    on_bytes: BytesCallback,
}

impl Default for SerialTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl SerialTransport {
    pub fn new() -> Self {
        Self {
            snapshot: Rc::new(RefCell::new(TransportSnapshot::default())),
            demo: Rc::new(RefCell::new(DemoShell::new())),
            demo_timer_id: Rc::new(RefCell::new(None)),
            demo_closure: Rc::new(RefCell::new(None)),
            on_state: Rc::new(RefCell::new(None)),
            on_bytes: Rc::new(RefCell::new(None)),
        }
    }

    pub fn snapshot(&self) -> TransportSnapshot {
        self.snapshot.borrow().clone()
    }

    pub fn init<FS, FB>(&self, on_state: FS, on_bytes: FB)
    where
        FS: FnMut(TransportSnapshot) + 'static,
        FB: FnMut(&[u8]) + 'static,
    {
        *self.on_state.borrow_mut() = Some(Box::new(on_state));
        *self.on_bytes.borrow_mut() = Some(Box::new(on_bytes));

        #[derive(Deserialize)]
        struct JsStatePayload {
            status: String,
            transport: String,
            device_name: String,
            vid_pid: String,
            port_index: u32,
            port_count: u32,
            dtr: bool,
            rts: bool,
            error_message: String,
        }

        let snap_ref = self.snapshot.clone();
        let on_state_ref = self.on_state.clone();
        let state_cb = Closure::<dyn FnMut(String)>::new(move |json_str: String| {
            let Ok(p) = serde_json::from_str::<JsStatePayload>(&json_str) else {
                return;
            };
            let error_message = if p.error_message.is_empty() {
                None
            } else {
                Some(p.error_message)
            };
            let next = TransportSnapshot {
                status: match p.status.as_str() {
                    "connecting" => ConnectionStatus::Connecting,
                    "connected" => ConnectionStatus::Connected,
                    _ => ConnectionStatus::Waiting,
                },
                transport: match p.transport.as_str() {
                    "webserial" => TransportKind::WebSerial,
                    "webusb" => TransportKind::WebUsb,
                    _ => TransportKind::None,
                },
                device_name: if p.device_name.is_empty() {
                    "Waiting for USB...".to_string()
                } else {
                    p.device_name
                },
                vid_pid: p.vid_pid,
                port_index: p.port_index,
                port_count: p.port_count,
                dtr: p.dtr,
                rts: p.rts,
                error_message,
            };

            if snap_ref.borrow().transport == TransportKind::Demo
                && next.status != ConnectionStatus::Connected
            {
                return;
            }

            *snap_ref.borrow_mut() = next.clone();
            if let Some(cb) = on_state_ref.borrow_mut().as_mut() {
                cb(next);
            }
        });

        let on_bytes_ref = self.on_bytes.clone();
        let bytes_cb = Closure::<dyn FnMut(js_sys::Uint8Array)>::new(move |arr: js_sys::Uint8Array| {
            let data = arr.to_vec();
            if let Some(cb) = on_bytes_ref.borrow_mut().as_mut() {
                cb(&data);
            }
        });

        js_init_serial(
            state_cb.as_ref().unchecked_ref(),
            bytes_cb.as_ref().unchecked_ref(),
        );
        state_cb.forget();
        bytes_cb.forget();
    }

    pub fn connect(&self, cfg: &SerialPortConfig) {
        self.stop_demo_timer();
        let baud = cfg.baud_rate;
        let db = cfg.data_bits;
        let sb = cfg.stop_bits;
        let par = cfg.parity;
        let fc = cfg.flow_control;
        let snap_ref = self.snapshot.clone();
        let on_state_ref = self.on_state.clone();

        spawn_local(async move {
            let res = wasm_bindgen_futures::JsFuture::from(js_connect_serial(
                baud, db, sb, par, fc,
            ))
            .await;
            if let Err(err) = res {
                let msg = err
                    .as_string()
                    .or_else(|| {
                        js_sys::Reflect::get(&err, &JsValue::from_str("message"))
                            .ok()
                            .and_then(|v| v.as_string())
                    })
                    .unwrap_or_else(|| "Serial connection cancelled".to_string());
                let next = TransportSnapshot {
                    error_message: Some(msg),
                    ..Default::default()
                };
                *snap_ref.borrow_mut() = next.clone();
                if let Some(cb) = on_state_ref.borrow_mut().as_mut() {
                    cb(next);
                }
            }
        });
    }

    pub fn start_demo(&self) {
        self.stop_demo_timer();
        let snap = TransportSnapshot {
            status: ConnectionStatus::Connected,
            transport: TransportKind::Demo,
            device_name: "XIAO-ESP32-S3 (Demo)".to_string(),
            vid_pid: "DEMO:0001".to_string(),
            port_index: 0,
            port_count: 1,
            dtr: true,
            rts: false,
            error_message: None,
        };
        *self.snapshot.borrow_mut() = snap.clone();
        if let Some(cb) = self.on_state.borrow_mut().as_mut() {
            cb(snap);
        }

        let banner = self.demo.borrow().banner();
        if let Some(cb) = self.on_bytes.borrow_mut().as_mut() {
            cb(&banner);
        }

        let demo_ref = self.demo.clone();
        let on_bytes_ref = self.on_bytes.clone();
        let closure = Closure::<dyn FnMut()>::new(move || {
            if let Some(bytes) = demo_ref.borrow_mut().tick_heartbeat() {
                if let Some(cb) = on_bytes_ref.borrow_mut().as_mut() {
                    cb(&bytes);
                }
            }
        });
        if let Some(win) = web_sys::window() {
            if let Ok(id) = win.set_interval_with_callback_and_timeout_and_arguments_0(
                closure.as_ref().unchecked_ref(),
                2000,
            ) {
                *self.demo_timer_id.borrow_mut() = Some(id);
                *self.demo_closure.borrow_mut() = Some(closure);
            }
        }
    }

    pub fn disconnect(&self) {
        self.stop_demo_timer();
        if self.snapshot.borrow().transport == TransportKind::Demo {
            let next = TransportSnapshot::default();
            *self.snapshot.borrow_mut() = next.clone();
            if let Some(cb) = self.on_state.borrow_mut().as_mut() {
                cb(next);
            }
            return;
        }
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(js_disconnect_serial()).await;
        });
    }

    fn stop_demo_timer(&self) {
        if let Some(id) = self.demo_timer_id.borrow_mut().take() {
            if let Some(win) = web_sys::window() {
                win.clear_interval_with_handle(id);
            }
        }
        *self.demo_closure.borrow_mut() = None;
    }

    pub fn send_bytes(&self, bytes: &[u8]) {
        if self.snapshot.borrow().transport == TransportKind::Demo {
            let reply = self.demo.borrow_mut().handle_input(bytes);
            if !reply.is_empty() {
                if let Some(cb) = self.on_bytes.borrow_mut().as_mut() {
                    cb(&reply);
                }
            }
            return;
        }
        let owned = bytes.to_vec();
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(js_write_serial(&owned)).await;
        });
    }

    pub fn set_signals(&self, dtr: bool, rts: bool) {
        let mut snap = self.snapshot.borrow().clone();
        snap.dtr = dtr;
        snap.rts = rts;
        *self.snapshot.borrow_mut() = snap.clone();
        if let Some(cb) = self.on_state.borrow_mut().as_mut() {
            cb(snap);
        }
        if self.snapshot.borrow().transport == TransportKind::Demo {
            return;
        }
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(js_set_signals(dtr, rts)).await;
        });
    }

    pub fn pulse_reset(&self) {
        if self.snapshot.borrow().transport == TransportKind::Demo {
            let reply = self.demo.borrow_mut().handle_input(b"reboot\r\n");
            if let Some(cb) = self.on_bytes.borrow_mut().as_mut() {
                cb(&reply);
            }
            return;
        }
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(js_pulse_reset()).await;
        });
    }

    pub fn reconfigure(&self, cfg: &SerialPortConfig) {
        if self.snapshot.borrow().transport == TransportKind::Demo
            || self.snapshot.borrow().status != ConnectionStatus::Connected
        {
            return;
        }
        let baud = cfg.baud_rate;
        let db = cfg.data_bits;
        let sb = cfg.stop_bits;
        let par = cfg.parity;
        let fc = cfg.flow_control;
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(js_reconfigure_serial(
                baud, db, sb, par, fc,
            ))
            .await;
        });
    }

    pub fn switch_usb_port(&self, port_idx: u32) {
        if self.snapshot.borrow().transport != TransportKind::WebUsb {
            return;
        }
        spawn_local(async move {
            let _ = wasm_bindgen_futures::JsFuture::from(js_switch_usb_port(port_idx)).await;
        });
    }
}
