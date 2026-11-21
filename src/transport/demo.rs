/// Interactive ESP32-S3 Demo serial shell for zero-hardware testing.
pub struct DemoShell {
    rx_line: String,
    uptime_ticks: u32,
}

impl Default for DemoShell {
    fn default() -> Self {
        Self::new()
    }
}

impl DemoShell {
    pub fn new() -> Self {
        Self {
            rx_line: String::new(),
            uptime_ticks: 0,
        }
    }

    pub fn banner(&self) -> Vec<u8> {
        b"\r\nHotWire Demo Shell (XIAO-ESP32-S3 @ 115200 8N1)\r\nType 'help', 'status', 'AT', or 'reboot'.\r\n> "
            .to_vec()
    }

    pub fn tick_heartbeat(&mut self) -> Option<Vec<u8>> {
        self.uptime_ticks += 1;
        if self.uptime_ticks.is_multiple_of(8) {
            Some(
                format!(
                    "\r\n[telemetry] uptime={}s vbat=4.12V temp=34.2C rssi=-51dBm\r\n> ",
                    self.uptime_ticks * 2
                )
                .into_bytes(),
            )
        } else {
            None
        }
    }

    pub fn handle_input(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for &b in bytes {
            if b == b'\r' || b == b'\n' {
                let cmd = self.rx_line.trim().to_string();
                self.rx_line.clear();
                if !cmd.is_empty() {
                    out.extend_from_slice(self.exec_cmd(&cmd).as_bytes());
                } else {
                    out.extend_from_slice(b"\r\n> ");
                }
            } else if (32..127).contains(&b) && self.rx_line.len() < 128 {
                self.rx_line.push(b as char);
            }
        }
        out
    }

    fn exec_cmd(&self, cmd: &str) -> String {
        match cmd.to_ascii_lowercase().as_str() {
            "help" => "\r\nCommands: help | status | AT | reboot | pins\r\n> ".to_string(),
            "status" => format!(
                "\r\nBoard: XIAO-ESP32-S3 | Heap: 214 KB | Uptime: {}s | USB: CDC-ACM\r\n> ",
                self.uptime_ticks * 2
            ),
            "at" => "\r\nOK\r\n> ".to_string(),
            "pins" => "\r\nD0=GPIO1 D1=GPIO2 D2=GPIO3 D3=GPIO4 D6=GPIO43 D7=GPIO44\r\n> ".to_string(),
            "reboot" => "\r\nESP-ROM:esp32s3-20210327\r\nrst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)\r\nReady.\r\n> ".to_string(),
            _ => format!("\r\nEcho: {cmd}\r\n> "),
        }
    }
}
