/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 Kari Vierimaa, Kempele
 *
 * HotWire Serial Terminal — Hardware USB-to-UART Bridge Firmware
 * Target: Seeed Studio XIAO ESP32-S3
 *
 * Default Pinout (3.3 V TTL):
 *   - TX (Output to target RX): D6 (GPIO43)
 *   - RX (Input from target TX): D7 (GPIO44)
 *   - Supports software TX/RX pin-swap (D6 <-> D7) and signal inversion!
 *
 * Protocol (0xAA 0x55 TYPE LEN_LO LEN_HI PAYLOAD... XOR):
 *   - Host -> Device:
 *       0x01 / 0x02: GET_CAPS -> replies 0x83 JSON
 *       0x50: UART_CFG (8B: u32 baud_le, u8 data_bits, u8 stop_bits, u8 parity, u8 flags)
 *             flags: bit0=swap_pins, bit1=invert_rx, bit2=invert_tx
 *       0x51: UART_TX (1..1024B raw bytes to write to Serial1)
 *       0xF0: BOOTLOADER (4B magic: B0 07 10 AD)
 *   - Device -> Host:
 *       0x83: BOARD_CAPABILITIES JSON
 *       0x87: UART_RX (1..512B raw bytes read from Serial1)
 *
 * Arduino IDE Settings:
 *   - Board: "XIAO_ESP32S3"
 *   - USB CDC On Boot: "Default" (Hardware CDC)
 */

#include <Arduino.h>
#include <string.h>
#include "driver/uart.h"
#include "soc/rtc_cntl_reg.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "freertos/queue.h"
#include "hotwire_protocol.h"

#ifndef CONFIG_IDF_TARGET_ESP32S3
  #error "This sketch targets Seeed Studio XIAO ESP32-S3."
#endif

#define HOTWIRE_FW_VERSION "1.1.1-uart"
#define HOTWIRE_BOARD_NAME "XIAO-ESP32-S3"

static const int PIN_TX_DEFAULT = 43; // D6
static const int PIN_RX_DEFAULT = 44; // D7

static const uint8_t SYNC_0 = 0xAA;
static const uint8_t SYNC_1 = 0x55;

static const uint8_t CMD_PING_STATUS = 0x01;
static const uint8_t CMD_GET_CAPS    = 0x02;
static const uint8_t CMD_UART_CFG    = 0x50;
static const uint8_t CMD_UART_TX     = 0x51;
static const uint8_t CMD_BOOTLOADER  = 0xF0;

static const uint8_t TYPE_BOARD_CAPS = 0x83;
static const uint8_t TYPE_UART_RX    = 0x87;

static SemaphoreHandle_t g_serial_mutex = nullptr;
static SemaphoreHandle_t g_uart_mutex = nullptr;

// UART TX is decoupled from the USB command task so a slow target baud rate
// can never block STOP / reconfiguration commands at the USB side.
static const size_t UART_TX_CHUNK_BYTES = 256;
static const UBaseType_t UART_TX_QUEUE_DEPTH = 16;
struct UartTxChunk {
  uint16_t len;
  uint8_t data[UART_TX_CHUNK_BYTES];
};
static QueueHandle_t g_uart_tx_queue = nullptr;

static uint32_t g_baud = 115200;
static uint8_t  g_data_bits = 8;
static uint8_t  g_stop_bits = 1;
static uint8_t  g_parity = 0;
static uint8_t  g_flags = 0; // bit0=swap, bit1=inv_rx, bit2=inv_tx

static uint8_t compute_xor(const uint8_t* data, size_t len) {
  uint8_t x = 0;
  for (size_t i = 0; i < len; ++i) x ^= data[i];
  return x;
}

static void serial_write_all(const uint8_t* data, size_t len) {
  size_t sent = 0;
  uint32_t start_ms = millis();
  while (sent < len) {
    size_t chunk = min<size_t>(512, len - sent);
    size_t written = Serial.write(data + sent, chunk);
    if (written > 0) {
      sent += written;
      start_ms = millis();
    } else {
      if ((millis() - start_ms) > 200) break;
      vTaskDelay(pdMS_TO_TICKS(1));
    }
  }
}

static void send_frame(uint8_t type_id, const uint8_t* payload, uint16_t len) {
  uint8_t hdr[5] = {
    SYNC_0, SYNC_1, type_id,
    (uint8_t)(len & 0xFF), (uint8_t)((len >> 8) & 0xFF)
  };
  uint8_t chk = compute_xor(hdr, 5) ^ compute_xor(payload, len);

  if (g_serial_mutex) xSemaphoreTake(g_serial_mutex, portMAX_DELAY);
  serial_write_all(hdr, 5);
  if (len > 0) serial_write_all(payload, len);
  serial_write_all(&chk, 1);
  if (g_serial_mutex) xSemaphoreGive(g_serial_mutex);
}

static void send_capabilities() {
  const char* json =
    "{\"board\":\"" HOTWIRE_BOARD_NAME "\","
    "\"firmware\":\"" HOTWIRE_FW_VERSION "\",\"schema\":2,\"tool\":\"serial\","
    "\"uart_bridge\":true,\"tx_pin\":\"D6\",\"rx_pin\":\"D7\",\"max_baud\":2000000}";
  send_frame(TYPE_BOARD_CAPS, (const uint8_t*)json, (uint16_t)strlen(json));
}

static uint32_t resolve_uart_config(uint8_t data_bits, uint8_t stop_bits, uint8_t parity) {
  bool is7 = (data_bits == 7);
  bool two_stop = (stop_bits == 2);
  if (parity == 1) {
    return is7 ? (two_stop ? SERIAL_7O2 : SERIAL_7O1) : (two_stop ? SERIAL_8O2 : SERIAL_8O1);
  } else if (parity == 2) {
    return is7 ? (two_stop ? SERIAL_7E2 : SERIAL_7E1) : (two_stop ? SERIAL_8E2 : SERIAL_8E1);
  }
  return is7 ? (two_stop ? SERIAL_7N2 : SERIAL_7N1) : (two_stop ? SERIAL_8N2 : SERIAL_8N1);
}

static void apply_uart_config() {
  if (g_uart_mutex) xSemaphoreTake(g_uart_mutex, portMAX_DELAY);
  if (g_uart_tx_queue) xQueueReset(g_uart_tx_queue);
  Serial1.end();
  Serial1.setRxBufferSize(4096);

  bool swap = (g_flags & 0x01) != 0;
  bool inv_rx = (g_flags & 0x02) != 0;
  bool inv_tx = (g_flags & 0x04) != 0;
  int tx_pin = swap ? PIN_RX_DEFAULT : PIN_TX_DEFAULT;
  int rx_pin = swap ? PIN_TX_DEFAULT : PIN_RX_DEFAULT;
  uint32_t cfg = resolve_uart_config(g_data_bits, g_stop_bits, g_parity);

  Serial1.begin(g_baud, cfg, rx_pin, tx_pin);
  uint32_t inv_mask = 0;
  if (inv_rx) inv_mask |= UART_SIGNAL_RXD_INV;
  if (inv_tx) inv_mask |= UART_SIGNAL_TXD_INV;
  uart_set_line_inverse(UART_NUM_1, inv_mask);

  if (g_uart_mutex) xSemaphoreGive(g_uart_mutex);
}

static void handle_frame(uint8_t cmd, const uint8_t* payload, uint16_t len) {
  switch (cmd) {
    case CMD_PING_STATUS:
    case CMD_GET_CAPS:
      send_capabilities();
      break;
    case CMD_UART_CFG:
      if (len >= 8) {
        uint32_t baud = (uint32_t)payload[0] | ((uint32_t)payload[1] << 8) |
                        ((uint32_t)payload[2] << 16) | ((uint32_t)payload[3] << 24);
        g_baud = constrain(baud, 300UL, 2000000UL);
        g_data_bits = (payload[4] == 7) ? 7 : 8;
        g_stop_bits = (payload[5] == 2) ? 2 : 1;
        g_parity = min<uint8_t>(payload[6], 2);
        g_flags = payload[7] & 0x07;
        apply_uart_config();
      }
      break;
    case CMD_UART_TX:
      if (len > 0 && g_uart_tx_queue != nullptr) {
        size_t off = 0;
        while (off < len) {
          UartTxChunk chunk = {};
          size_t n = min<size_t>(UART_TX_CHUNK_BYTES, (size_t)len - off);
          chunk.len = (uint16_t)n;
          memcpy(chunk.data, payload + off, n);
          // Non-blocking: if the target is slower than USB, newest data is
          // dropped rather than freezing the command/UART-RX pipeline.
          if (xQueueSend(g_uart_tx_queue, &chunk, 0) != pdTRUE) {
            break;
          }
          off += n;
        }
      }
      break;
    case CMD_BOOTLOADER:
      if (len >= 4 && hotwire_is_bootloader_magic(payload[0], payload[1], payload[2], payload[3])) {
        Serial1.end();
        vTaskDelay(pdMS_TO_TICKS(20));
        REG_WRITE(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
        vTaskDelay(pdMS_TO_TICKS(10));
        esp_restart();
      }
      break;
    default:
      break;
  }
}

static void uart_tx_task(void* arg) {
  (void)arg;
  UartTxChunk chunk;
  for (;;) {
    if (xQueueReceive(g_uart_tx_queue, &chunk, portMAX_DELAY) != pdTRUE) {
      continue;
    }
    size_t sent = 0;
    while (sent < chunk.len) {
      int avail = 0;
      size_t written = 0;
      if (g_uart_mutex) xSemaphoreTake(g_uart_mutex, portMAX_DELAY);
      avail = Serial1.availableForWrite();
      if (avail > 0) {
        size_t n = min<size_t>((size_t)avail, (size_t)chunk.len - sent);
        written = Serial1.write(chunk.data + sent, n);
      }
      if (g_uart_mutex) xSemaphoreGive(g_uart_mutex);
      if (written > 0) {
        sent += written;
      } else {
        vTaskDelay(1);
      }
    }
  }
}

static void uart_rx_task(void* arg) {
  (void)arg;
  static uint8_t rx_buf[512];

  while (true) {
    int avail = 0;
    if (g_uart_mutex) xSemaphoreTake(g_uart_mutex, portMAX_DELAY);
    avail = Serial1.available();
    if (avail > 0) {
      size_t to_read = min<size_t>((size_t)avail, sizeof(rx_buf));
      size_t got = Serial1.readBytes(rx_buf, to_read);
      if (g_uart_mutex) xSemaphoreGive(g_uart_mutex);
      if (got > 0) {
        send_frame(TYPE_UART_RX, rx_buf, (uint16_t)got);
      }
    } else {
      if (g_uart_mutex) xSemaphoreGive(g_uart_mutex);
      vTaskDelay(pdMS_TO_TICKS(1));
    }
  }
}

static void usb_rx_task(void* arg) {
  (void)arg;
  enum State { S_SYNC0, S_SYNC1, S_TYPE, S_LEN0, S_LEN1, S_PAYLOAD, S_CHK };
  State st = S_SYNC0;
  uint8_t type_id = 0;
  uint16_t len = 0;
  uint16_t pos = 0;
  static uint8_t payload[1030];

  while (true) {
    while (Serial.available() > 0) {
      uint8_t b = (uint8_t)Serial.read();
      switch (st) {
        case S_SYNC0:
          if (b == SYNC_0) st = S_SYNC1;
          break;
        case S_SYNC1:
          if (b == SYNC_1) st = S_TYPE;
          else if (b != SYNC_0) st = S_SYNC0;
          break;
        case S_TYPE:
          type_id = b;
          st = S_LEN0;
          break;
        case S_LEN0:
          len = b;
          st = S_LEN1;
          break;
        case S_LEN1:
          len |= ((uint16_t)b << 8);
          if (len > sizeof(payload)) {
            st = S_SYNC0;
          } else if (len == 0) {
            st = S_CHK;
          } else {
            pos = 0;
            st = S_PAYLOAD;
          }
          break;
        case S_PAYLOAD:
          payload[pos++] = b;
          if (pos >= len) st = S_CHK;
          break;
        case S_CHK: {
          uint8_t hdr[5] = { SYNC_0, SYNC_1, type_id, (uint8_t)(len & 0xFF), (uint8_t)(len >> 8) };
          uint8_t expected = compute_xor(hdr, 5) ^ compute_xor(payload, len);
          if (b == expected) {
            handle_frame(type_id, payload, len);
          }
          st = S_SYNC0;
          break;
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }
}

void setup() {
  Serial.setRxBufferSize(4096);
  Serial.setTxBufferSize(8192);
  Serial.begin(921600);

  g_serial_mutex = xSemaphoreCreateMutex();
  g_uart_mutex = xSemaphoreCreateMutex();
  g_uart_tx_queue = xQueueCreate(UART_TX_QUEUE_DEPTH, sizeof(UartTxChunk));
  apply_uart_config();

  xTaskCreatePinnedToCore(usb_rx_task, "usb_rx", 4096, nullptr, 4, nullptr, 0);
  xTaskCreatePinnedToCore(uart_rx_task, "uart_rx", 4096, nullptr, 3, nullptr, 1);
  xTaskCreatePinnedToCore(uart_tx_task, "uart_tx", 3072, nullptr, 2, nullptr, 1);
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
}
