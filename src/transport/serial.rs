pub use hotwire_core::transport::{
    HotWireTransport as SerialTransport, SerialConfig, TransportKind, TransportSnapshot,
};

use crate::protocol::build_bootloader_frame;
use crate::storage::preferences::SerialPortConfig;
use crate::transport::demo::DemoShell;

pub fn to_core_serial_config(cfg: &SerialPortConfig, auto_connect: bool) -> SerialConfig {
    SerialConfig {
        baud_rate: cfg.baud_rate,
        data_bits: cfg.data_bits,
        stop_bits: cfg.stop_bits,
        parity: cfg.parity,
        flow_control: cfg.flow_control,
        buffer_size: 16_384,
        force_dtr: None,
        force_rts: None,
        auto_connect,
        storage_key: "hotwire_serial_last_device".to_string(),
    }
}

pub fn create_terminal_transport(cfg: &SerialPortConfig, auto_connect: bool) -> SerialTransport {
    let transport = SerialTransport::with_demo(
        to_core_serial_config(cfg, auto_connect),
        DemoShell::new(),
    );
    // Direct USB terminal mode must not transmit binary handshake frames automatically.
    transport.set_init_commands(Vec::new());
    transport.set_bootloader_command(build_bootloader_frame());
    transport
}
