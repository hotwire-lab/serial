use serde::{Deserialize, Serialize};

use crate::buffer::formatters::ViewMode;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LineEnding {
    Crlf,
    Lf,
    Cr,
    Raw,
}

impl LineEnding {
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Crlf => "CRLF",
            LineEnding::Lf => "LF",
            LineEnding::Cr => "CR",
            LineEnding::Raw => "RAW",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "LF" => LineEnding::Lf,
            "CR" => LineEnding::Cr,
            "RAW" => LineEnding::Raw,
            _ => LineEnding::Crlf,
        }
    }

    pub fn suffix(self) -> &'static str {
        match self {
            LineEnding::Crlf => "\r\n",
            LineEnding::Lf => "\n",
            LineEnding::Cr => "\r",
            LineEnding::Raw => "",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MacroItem {
    pub id: String,
    pub label: String,
    pub payload: String,
    pub line_ending: LineEnding,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerialPortConfig {
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: u8,       // 0=None, 1=Odd, 2=Even
    pub flow_control: u8, // 0=None, 1=RTS/CTS
}

impl Default for SerialPortConfig {
    fn default() -> Self {
        Self {
            baud_rate: 115200,
            data_bits: 8,
            stop_bits: 1,
            parity: 0,
            flow_control: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalMode {
    DirectUsb,
    XiaoUartBridge,
}

impl TerminalMode {
    pub fn as_str(self) -> &'static str {
        match self {
            TerminalMode::DirectUsb => "direct",
            TerminalMode::XiaoUartBridge => "bridge",
        }
    }

    pub fn from_str(s: &str) -> Self {
        if s == "bridge" {
            TerminalMode::XiaoUartBridge
        } else {
            TerminalMode::DirectUsb
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HotWirePreferences {
    pub mode: TerminalMode,
    pub serial: SerialPortConfig,
    pub bridge_swap_pins: bool,
    pub bridge_invert_rx: bool,
    pub bridge_invert_tx: bool,
    pub line_ending: LineEnding,
    pub local_echo: bool,
    pub view_mode: ViewMode,
    pub show_timestamps: bool,
    pub show_invisible: bool,
    pub font_size: u8,
    pub macros: Vec<MacroItem>,
}

impl Default for HotWirePreferences {
    fn default() -> Self {
        Self {
            mode: TerminalMode::DirectUsb,
            serial: SerialPortConfig::default(),
            bridge_swap_pins: false,
            bridge_invert_rx: false,
            bridge_invert_tx: false,
            line_ending: LineEnding::Crlf,
            local_echo: true,
            view_mode: ViewMode::Ascii,
            show_timestamps: false,
            show_invisible: false,
            font_size: 13,
            macros: vec![
                MacroItem {
                    id: "help".into(),
                    label: "help".into(),
                    payload: "help".into(),
                    line_ending: LineEnding::Crlf,
                },
                MacroItem {
                    id: "status".into(),
                    label: "status".into(),
                    payload: "status".into(),
                    line_ending: LineEnding::Crlf,
                },
                MacroItem {
                    id: "reboot".into(),
                    label: "reboot".into(),
                    payload: "reboot".into(),
                    line_ending: LineEnding::Crlf,
                },
                MacroItem {
                    id: "at".into(),
                    label: "AT".into(),
                    payload: "AT".into(),
                    line_ending: LineEnding::Crlf,
                },
            ],
        }
    }
}

const PREFS_KEY: &str = "hotwire_serial_wasm_prefs_v1";

pub fn load_preferences() -> HotWirePreferences {
    let raw = web_sys::window()
        .and_then(|w| w.local_storage().ok().flatten())
        .and_then(|s| s.get_item(PREFS_KEY).ok().flatten());
    if let Some(json) = raw {
        if let Ok(parsed) = serde_json::from_str::<HotWirePreferences>(&json) {
            return parsed;
        }
    }
    HotWirePreferences::default()
}

pub fn save_preferences(prefs: &HotWirePreferences) {
    if let Some(storage) = web_sys::window().and_then(|w| w.local_storage().ok().flatten()) {
        if let Ok(json) = serde_json::to_string(prefs) {
            let _ = storage.set_item(PREFS_KEY, &json);
        }
    }
}

pub const BAUD_RATES: [u32; 8] = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_json_roundtrip() {
        let mut p = HotWirePreferences::default();
        p.serial.baud_rate = 921600;
        p.view_mode = ViewMode::Hex;
        let json = serde_json::to_string(&p).unwrap();
        let back: HotWirePreferences = serde_json::from_str(&json).unwrap();
        assert_eq!(back, p);
    }
}
