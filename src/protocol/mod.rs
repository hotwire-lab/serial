pub use hotwire_core::protocol::{build_bootloader_frame, build_get_caps_frame, encode_frame};
#[cfg(test)]
use hotwire_core::protocol::{
    BoardIdentity, FrameDemuxer, FrameRule, TYPE_BOARD_CAPABILITIES as TYPE_BOARD_CAPS,
};
use serde::Deserialize;

pub const CMD_UART_CFG: u8 = 0x50;
pub const CMD_UART_TX: u8 = 0x51;

pub const TYPE_UART_RX: u8 = 0x87;

pub fn build_uart_cfg_frame(
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: u8,
    swap_pins: bool,
    invert_rx: bool,
    invert_tx: bool,
) -> Vec<u8> {
    let mut flags = 0u8;
    if swap_pins {
        flags |= 0x01;
    }
    if invert_rx {
        flags |= 0x02;
    }
    if invert_tx {
        flags |= 0x04;
    }
    let mut payload = Vec::with_capacity(8);
    payload.extend_from_slice(&baud_rate.clamp(300, 2_000_000).to_le_bytes());
    payload.push(if data_bits == 7 { 7 } else { 8 });
    payload.push(if stop_bits == 2 { 2 } else { 1 });
    payload.push(parity.min(2));
    payload.push(flags);
    encode_frame(CMD_UART_CFG, &payload)
}

pub fn build_uart_tx_frames(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 16);
    for chunk in bytes.chunks(1024) {
        out.extend_from_slice(&encode_frame(CMD_UART_TX, chunk));
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BridgeCapabilities {
    pub board: String,
    pub firmware: String,
    #[serde(default)]
    pub uart_bridge: bool,
    #[serde(default)]
    pub tx_pin: String,
    #[serde(default)]
    pub rx_pin: String,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq)]
pub enum BridgePacket {
    Capabilities(BoardIdentity, BridgeCapabilities),
    UartRx(Vec<u8>),
}

#[cfg(test)]
pub struct BridgeDemuxer {
    inner: FrameDemuxer,
}

#[cfg(test)]
impl Default for BridgeDemuxer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl BridgeDemuxer {
    pub fn new() -> Self {
        Self {
            inner: FrameDemuxer::new(vec![
                FrameRule::board_capabilities(),
                FrameRule::new(TYPE_UART_RX, 0, 4096),
            ]),
        }
    }

    pub fn feed<F>(&mut self, bytes: &[u8], mut on_packet: F)
    where
        F: FnMut(BridgePacket),
    {
        self.inner.feed(bytes, |raw| match raw.type_id {
            TYPE_BOARD_CAPS => {
                if let Some(id) = BoardIdentity::decode_capabilities(raw.payload) {
                    if let Ok(caps) = serde_json::from_value::<BridgeCapabilities>(id.raw.clone()) {
                        on_packet(BridgePacket::Capabilities(id, caps));
                    }
                }
            }
            TYPE_UART_RX => {
                on_packet(BridgePacket::UartRx(raw.payload.to_vec()));
            }
            _ => {}
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demuxes_bridge_caps_and_uart_rx() {
        let caps_json = br#"{"board":"XIAO-ESP32-S3","firmware":"1.0.0-uart","uart_bridge":true,"tx_pin":"D6","rx_pin":"D7"}"#;
        let f1 = encode_frame(TYPE_BOARD_CAPS, caps_json);
        let f2 = encode_frame(TYPE_UART_RX, b"Hello UART!\r\n");

        let mut wire = Vec::new();
        wire.extend_from_slice(&[0xff, 0xaa, 0x00]); // noise
        wire.extend_from_slice(&f1);
        wire.extend_from_slice(&f2);

        let mut demux = BridgeDemuxer::new();
        let mut packets = Vec::new();
        demux.feed(&wire[..12], |p| packets.push(p));
        demux.feed(&wire[12..], |p| packets.push(p));

        assert_eq!(packets.len(), 2);
        match &packets[0] {
            BridgePacket::Capabilities(_, c) => {
                assert_eq!(c.board, "XIAO-ESP32-S3");
                assert!(c.uart_bridge);
            }
            _ => panic!("expected caps"),
        }
        assert_eq!(
            packets[1],
            BridgePacket::UartRx(b"Hello UART!\r\n".to_vec())
        );
    }
}
