use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::buffer::ring_buffer::{ChunkDirection, TerminalChunk};

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

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

fn push_timestamp_ms(out: &mut String, ms: u64) {
    let total_sec = (ms / 1000) % 86_400;
    let h = total_sec / 3600;
    let m = (total_sec % 3600) / 60;
    let s = total_sec % 60;
    let rem = ms % 1000;
    let _ = write!(out, "[{h:02}:{m:02}:{s:02}.{rem:03}] ");
}

#[allow(dead_code)]
pub fn format_timestamp_ms(ms: u64) -> String {
    let mut out = String::with_capacity(15);
    push_timestamp_ms(&mut out, ms);
    out
}

fn push_hex_bytes(out: &mut String, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    out.reserve(bytes.len() * 3);
    for (idx, &b) in bytes.iter().enumerate() {
        if idx > 0 {
            out.push(' ');
        }
        out.push(HEX_UPPER[(b >> 4) as usize] as char);
        out.push(HEX_UPPER[(b & 0x0f) as usize] as char);
    }
}

#[allow(dead_code)]
pub fn format_hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 3);
    push_hex_bytes(&mut out, bytes);
    out
}

/// Incrementally appends a single formatted chunk into `out` without allocating
/// per-chunk or per-byte intermediate `String`s.
pub fn append_formatted_chunk(
    out: &mut String,
    at_line_start: &mut bool,
    chunk: &TerminalChunk,
    mode: ViewMode,
    show_timestamps: bool,
    show_invisible: bool,
) {
    if mode == ViewMode::Hex {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        if show_timestamps {
            push_timestamp_ms(out, chunk.timestamp_ms);
        }
        out.push_str(if chunk.direction == ChunkDirection::Tx {
            "TX: "
        } else {
            "RX: "
        });
        push_hex_bytes(out, &chunk.data);
        out.push('\n');
        *at_line_start = true;
        return;
    }

    let raw = String::from_utf8_lossy(&chunk.data);
    out.reserve(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        // Strip ANSI CSI escape sequences (\x1b[...<final byte 0x40..=0x7E>)
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
            continue;
        }

        if show_invisible {
            if *at_line_start && show_timestamps && ch != '\n' {
                push_timestamp_ms(out, chunk.timestamp_ms);
                if chunk.direction == ChunkDirection::Tx {
                    out.push_str("TX> ");
                }
                *at_line_start = false;
            }
            match ch {
                '\r' => out.push('␍'),
                '\n' => {
                    out.push('␊');
                    out.push('\n');
                    *at_line_start = true;
                }
                '\t' => out.push('␉'),
                ' ' => out.push('·'),
                c if c.is_control() => {
                    let _ = write!(out, "\\x{:02X}", c as u32);
                }
                c => out.push(c),
            }
        } else if ch != '\r' {
            if *at_line_start && show_timestamps && ch != '\n' {
                push_timestamp_ms(out, chunk.timestamp_ms);
                if chunk.direction == ChunkDirection::Tx {
                    out.push_str("TX> ");
                }
            }
            out.push(ch);
            *at_line_start = ch == '\n';
        }
    }
}

/// Rebuilds the entire formatted viewport buffer into `out` and returns the
/// resulting `at_line_start` cursor state for subsequent incremental appends.
pub fn rebuild_formatted_into<'a, I>(
    out: &mut String,
    chunks: I,
    mode: ViewMode,
    show_timestamps: bool,
    show_invisible: bool,
) -> bool
where
    I: Iterator<Item = &'a TerminalChunk>,
{
    out.clear();
    let mut at_line_start = true;
    for chunk in chunks {
        append_formatted_chunk(
            out,
            &mut at_line_start,
            chunk,
            mode,
            show_timestamps,
            show_invisible,
        );
    }
    at_line_start
}

#[allow(dead_code)]
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
    rebuild_formatted_into(&mut out, chunks, mode, show_timestamps, show_invisible);
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

    #[test]
    fn incremental_append_matches_full_rebuild() {
        let chunks = [
            TerminalChunk {
                data: b"\x1b[32mBoot".to_vec(),
                timestamp_ms: 1000,
                direction: ChunkDirection::Rx,
            },
            TerminalChunk {
                data: b" OK\r\n".to_vec(),
                timestamp_ms: 1500,
                direction: ChunkDirection::Rx,
            },
            TerminalChunk {
                data: b"help\r\n".to_vec(),
                timestamp_ms: 2000,
                direction: ChunkDirection::Tx,
            },
        ];

        for mode in [ViewMode::Ascii, ViewMode::Hex] {
            for ts in [false, true] {
                for inv in [false, true] {
                    let full = format_chunks(chunks.iter(), mode, ts, inv);
                    let mut inc = String::new();
                    let mut at_start = true;
                    for c in &chunks {
                        append_formatted_chunk(&mut inc, &mut at_start, c, mode, ts, inv);
                    }
                    assert_eq!(inc, full, "mismatch for mode={mode:?} ts={ts} inv={inv}");
                }
            }
        }
    }
}
