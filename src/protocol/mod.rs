use serde::Deserialize;

pub const SYNC_0: u8 = 0xaa;
pub const SYNC_1: u8 = 0x55;

pub const CMD_GET_CAPS: u8 = 0x02;
pub const CMD_UART_CFG: u8 = 0x50;
pub const CMD_UART_TX: u8 = 0x51;
pub const CMD_BOOTLOADER: u8 = 0xf0;

pub const TYPE_BOARD_CAPS: u8 = 0x83;
pub const TYPE_UART_RX: u8 = 0x87;

pub fn compute_xor(bytes: &[u8]) -> u8 {
    let mut x = 0u8;
    for &b in bytes {
        x ^= b;
    }
    x
}

pub fn encode_frame(type_or_cmd: u8, payload: &[u8]) -> Vec<u8> {
    let len = payload.len();
    let mut frame = Vec::with_capacity(6 + len);
    frame.push(SYNC_0);
    frame.push(SYNC_1);
    frame.push(type_or_cmd);
    frame.push((len & 0xff) as u8);
    frame.push(((len >> 8) & 0xff) as u8);
    frame.extend_from_slice(payload);
    let chk = compute_xor(&frame);
    frame.push(chk);
    frame
}

pub fn build_get_caps_frame() -> Vec<u8> {
    encode_frame(CMD_GET_CAPS, &[])
}

pub fn build_bootloader_frame() -> Vec<u8> {
    encode_frame(CMD_BOOTLOADER, &[0xb0, 0x07, 0x10, 0xad])
}

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgePacket {
    Capabilities(BridgeCapabilities),
    UartRx(Vec<u8>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RxState {
    Sync0,
    Sync1,
    Type,
    LenLo,
    LenHi,
    Payload,
    Checksum,
}

pub struct BridgeDemuxer {
    state: RxState,
    type_id: u8,
    len: usize,
    payload: Vec<u8>,
}

impl Default for BridgeDemuxer {
    fn default() -> Self {
        Self::new()
    }
}

impl BridgeDemuxer {
    pub fn new() -> Self {
        Self {
            state: RxState::Sync0,
            type_id: 0,
            len: 0,
            payload: Vec::with_capacity(1024),
        }
    }

    pub fn reset(&mut self) {
        self.state = RxState::Sync0;
        self.type_id = 0;
        self.len = 0;
        self.payload.clear();
    }

    pub fn feed<F>(&mut self, bytes: &[u8], mut on_packet: F)
    where
        F: FnMut(BridgePacket),
    {
        for &b in bytes {
            match self.state {
                RxState::Sync0 => {
                    if b == SYNC_0 {
                        self.state = RxState::Sync1;
                    }
                }
                RxState::Sync1 => {
                    if b == SYNC_1 {
                        self.state = RxState::Type;
                    } else if b != SYNC_0 {
                        self.state = RxState::Sync0;
                    }
                }
                RxState::Type => {
                    if b == TYPE_BOARD_CAPS || b == TYPE_UART_RX {
                        self.type_id = b;
                        self.state = RxState::LenLo;
                    } else {
                        self.state = RxState::Sync0;
                    }
                }
                RxState::LenLo => {
                    self.len = b as usize;
                    self.state = RxState::LenHi;
                }
                RxState::LenHi => {
                    self.len |= (b as usize) << 8;
                    if self.len > 4096 {
                        self.reset();
                    } else if self.len == 0 {
                        self.payload.clear();
                        self.state = RxState::Checksum;
                    } else {
                        self.payload.clear();
                        self.payload.reserve(self.len);
                        self.state = RxState::Payload;
                    }
                }
                RxState::Payload => {
                    self.payload.push(b);
                    if self.payload.len() >= self.len {
                        self.state = RxState::Checksum;
                    }
                }
                RxState::Checksum => {
                    let hdr = [
                        SYNC_0,
                        SYNC_1,
                        self.type_id,
                        (self.len & 0xff) as u8,
                        ((self.len >> 8) & 0xff) as u8,
                    ];
                    let expected = compute_xor(&hdr) ^ compute_xor(&self.payload);
                    if b == expected {
                        match self.type_id {
                            TYPE_BOARD_CAPS => {
                                if let Ok(text) = std::str::from_utf8(&self.payload) {
                                    if let Ok(caps) = serde_json::from_str::<BridgeCapabilities>(text) {
                                        on_packet(BridgePacket::Capabilities(caps));
                                    }
                                }
                            }
                            TYPE_UART_RX => {
                                on_packet(BridgePacket::UartRx(self.payload.clone()));
                            }
                            _ => {}
                        }
                    }
                    self.reset();
                }
            }
        }
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
            BridgePacket::Capabilities(c) => {
                assert_eq!(c.board, "XIAO-ESP32-S3");
                assert!(c.uart_bridge);
            }
            _ => panic!("expected caps"),
        }
        assert_eq!(packets[1], BridgePacket::UartRx(b"Hello UART!\r\n".to_vec()));
    }
}
