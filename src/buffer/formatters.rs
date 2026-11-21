use serde::{Deserialize, Serialize};

use crate::buffer::ring_buffer::{ChunkDirection, TerminalChunk};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ViewMode {
    Ascii,
    Hex,
}

impl ViewMode {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            ViewMode::Ascii => "ASCII",
            ViewMode::Hex => "HEX",
        }
    }
}

pub fn format_timestamp_ms(ms: u64) -> String {
    let total_sec = (ms / 1000) % 86_400;
    let h = total_sec / 3600;
    let m = (total_sec % 3600) / 60;
    let s = total_sec % 60;
    let rem = ms % 1000;
    format!("[{h:02}:{m:02}:{s:02}.{rem:03}] ")
}

/// Strip ANSI CSI/OSC escape sequences while preserving clean readable terminal text.
fn decode_ascii_chunk(bytes: &[u8], show_invisible: bool) -> String {
    let raw = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        if show_invisible {
            match ch {
                '\r' => out.push('␍'),
                '\n' => {
                    out.push('␊');
                    out.push('\n');
                }
                '\t' => out.push('␉'),
                ' ' => out.push('·'),
                c if c.is_control() => out.push_str(&format!("\\x{:02X}", c as u32)),
                c => out.push(c),
            }
        } else if ch != '\r' {
            out.push(ch);
        }
    }
    out
}

pub fn format_hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 3);
    for (idx, b) in bytes.iter().enumerate() {
        if idx > 0 {
            out.push(' ');
        }
        out.push_str(&format!("{b:02X}"));
    }
    out
}

pub fn format_chunks<'a, I>(
    chunks: I,
    mode: ViewMode,
    show_timestamps: bool,
    show_invisible: bool,
) -> String
where
    I: Iterator<Item = &'a TerminalChunk>,
{
    let mut out = String::new();
    let mut at_line_start = true;

    for chunk in chunks {
        if mode == ViewMode::Hex {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            if show_timestamps {
                out.push_str(&format_timestamp_ms(chunk.timestamp_ms));
            }
            let dir_tag = if chunk.direction == ChunkDirection::Tx {
                "TX: "
            } else {
                "RX: "
            };
            out.push_str(dir_tag);
            out.push_str(&format_hex_bytes(&chunk.data));
            out.push('\n');
            at_line_start = true;
            continue;
        }

        let text = decode_ascii_chunk(&chunk.data, show_invisible);
        for ch in text.chars() {
            if at_line_start && show_timestamps && ch != '\n' {
                out.push_str(&format_timestamp_ms(chunk.timestamp_ms));
                if chunk.direction == ChunkDirection::Tx {
                    out.push_str("TX> ");
                }
            }
            out.push(ch);
            at_line_start = ch == '\n';
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_ascii_hex_and_invisible_chars() {
        let chunks = [
            TerminalChunk {
                data: b"OK\r\n".to_vec(),
                timestamp_ms: 1234,
                direction: ChunkDirection::Rx,
            },
            TerminalChunk {
                data: b"AT\r\n".to_vec(),
                timestamp_ms: 2000,
                direction: ChunkDirection::Tx,
            },
        ];

        let ascii = format_chunks(chunks.iter(), ViewMode::Ascii, false, false);
        assert_eq!(ascii, "OK\nAT\n");

        let inv = format_chunks(chunks.iter(), ViewMode::Ascii, false, true);
        assert_eq!(inv, "OK␍␊\nAT␍␊\n");

        let hex = format_chunks(chunks.iter(), ViewMode::Hex, false, false);
        assert!(hex.contains("RX: 4F 4B 0D 0A"));
        assert!(hex.contains("TX: 41 54 0D 0A"));
    }
}
