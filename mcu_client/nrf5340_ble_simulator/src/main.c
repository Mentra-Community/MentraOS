/*
 * Copyright (c) 2018 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

/** @file
 *  @brief Nordic UART Bridge Service (NUS) sample
 */
#include <uart_async_adapter.h>

#include <zephyr/types.h>
#include <zephyr/kernel.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/usb/usb_device.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/display.h>
#include <zephyr/drivers/gpio.h>
#include <soc.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>

#include "mentra_ble_service.h"
#include "protobuf_handler.h"
#include "pdm_audio_stream.h"
#include "bsp_log.h"
#include "mos_lvgl_display.h"  // Working LVGL display integration
// #include "display/lcd/a6n.h"  // Working A6N driver
#include "opt3006.h"  // OPT3006 ambient light sensor
#include "lsm6dsv16x.h"  // LSM6DSV16X 6-axis IMU sensor

#include <dk_buttons_and_leds.h>

#include <zephyr/settings/settings.h>

#include <stdio.h>
#include <string.h>
#include <stdbool.h>

#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <nrfx_clock.h>
#include <hal/nrf_usbreg.h>
#include <zephyr/irq.h>

#include "mos_fuel_gauge.h"
#include "opt3006.h"
#include "npm1300_led.h"

LOG_MODULE_REGISTER(main, LOG_LEVEL_DBG);

#define STACKSIZE 2048
#define PRIORITY 7

#define DEVICE_NAME CONFIG_BT_DEVICE_NAME
#define DEVICE_NAME_LEN	(sizeof(DEVICE_NAME) - 1)

#define RUN_STATUS_LED DK_LED1
#define RUN_LED_BLINK_INTERVAL 1000

#define CON_STATUS_LED DK_LED2

#define KEY_PASSKEY_ACCEPT DK_BTN1_MSK
#define KEY_PASSKEY_REJECT DK_BTN2_MSK

// **NEW: Updated button mappings to avoid SPI pin conflicts (P0.08/P0.09)**
#define KEY_BATTERY_CYCLE DK_BTN1_MSK           // Button 1: Cycle battery 0-100% + toggle charging
#define KEY_SCREEN_TOGGLE DK_BTN2_MSK           // Button 2: Cycle LVGL test patterns
#define KEY_PATTERN_CYCLE (DK_BTN1_MSK | DK_BTN2_MSK)  // Button 1+2: Cycle LVGL patterns

// **DISABLED: Buttons 3 & 4 conflict with SPI4 pins (P0.08 SCK, P0.09 MOSI)**
// #define KEY_BUTTON3 DK_BTN3_MSK              // P0.08 - conflicts with SPI4 SCK
// #define KEY_BUTTON4 DK_BTN4_MSK              // P0.09 - conflicts with SPI4 MOSI

#define UART_BUF_SIZE 240
#define UART_WAIT_FOR_BUF_DELAY K_MSEC(50)
#define UART_WAIT_FOR_RX 50

static K_SEM_DEFINE(ble_init_ok, 0, 1);

static struct bt_conn *current_conn;
static struct bt_conn *auth_conn;
static struct k_work adv_work;

/* USB cable detection using polling mode / USB线缆检测使用轮询模式 */
static struct k_work_delayable usb_detect_work;
static bool usb_connected = false;
#define USB_DETECT_POLL_INTERVAL_MS 1000  /* Poll every 1 second / 每1秒轮询一次 */

static const struct device *uart = DEVICE_DT_GET(DT_CHOSEN(nordic_nus_uart));
static struct k_work_delayable uart_work;

struct uart_data_t {
	void *fifo_reserved;
	uint8_t data[UART_BUF_SIZE];
	uint16_t len;
};
static uint16_t payload_mtu   = 20;
static bool     ble_connected = false; 
static struct bt_conn *my_current_conn;
static K_FIFO_DEFINE(fifo_uart_tx_data);
static K_FIFO_DEFINE(fifo_uart_rx_data);

static char dynamic_device_name[32] = "Nex1";
static struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA(BT_DATA_NAME_COMPLETE, "NexSim", 6),
};
static struct bt_data sd[] = {
	BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_MENTRA_VAL),
};
/**
 * @brief USB cable connected callback
 * USB线缆连接回调函数
 */
static void usb_cable_connected(void)
{
	LOG_INF("🔌 USB cable connected / USB线缆已连接");
	usb_connected = true;
	
	/* Display USB status on A6N screen / 在A6N屏幕上显示USB状态 */
	display_update_xy_text(350, 20, "[USB: ON]", 48, 0xFFFFFF);
}

/**
 * @brief USB cable disconnected callback
 * USB线缆断开回调函数
 */
static void usb_cable_disconnected(void)
{
	LOG_INF("🔌 USB cable disconnected / USB线缆已断开");
	usb_connected = false;
	
	/* Display USB status on A6N screen / 在A6N屏幕上显示USB状态 */
	display_update_xy_text(350, 20, "[USB: OFF]", 48, 0xFFFFFF);
}

/**
 * @brief USB detection work handler (polling mode)
 * USB检测工作处理函数（轮询模式）
 * 
 * Periodically polls the USBREGULATOR status register to detect
 * USB cable insertion/removal.
 * 
 * 定期轮询USBREGULATOR状态寄存器以检测USB线缆插拔。
 */
static void usb_detect_work_handler(struct k_work *work)
{
	uint32_t status = nrf_usbreg_status_get(NRF_USBREGULATOR_NS);
	bool current_vbus = (status & NRF_USBREG_STATUS_VBUSDETECT_MASK) != 0;

	if (current_vbus && !usb_connected)
	{
		usb_cable_connected();
	}
	else if (!current_vbus && usb_connected)
	{
		usb_cable_disconnected();
	}

	/* Schedule next poll / 安排下次轮询 */
	k_work_schedule(&usb_detect_work, K_MSEC(USB_DETECT_POLL_INTERVAL_MS));
}

/**
 * @brief Initialize USB cable detection (polling mode)
 * 初始化USB线缆检测（轮询模式）
 * 
 * Initializes USB cable detection using polling mode.
 * 初始化USB线缆检测，使用轮询模式。
 * 
 * @return 0 on success, negative error code on failure
 */
static int usb_detect_init(void)
{
	LOG_INF("🔌 Initializing USB cable detection (polling mode) / 初始化USB线缆检测（轮询模式）");
	LOG_INF("Polling interval: %d ms / 轮询间隔: %d毫秒", 
		USB_DETECT_POLL_INTERVAL_MS, USB_DETECT_POLL_INTERVAL_MS);
	
	/* Initialize delayed work for polling / 初始化延迟工作用于轮询 */
	k_work_init_delayable(&usb_detect_work, usb_detect_work_handler);
	
	/* Check initial USB cable state and display on screen / 检查初始USB线缆状态并显示在屏幕上 */
	uint32_t status = nrf_usbreg_status_get(NRF_USBREGULATOR_NS);
	
	if (status & NRF_USBREG_STATUS_VBUSDETECT_MASK)
	{
		usb_connected = true;
		LOG_INF("🔌 USB cable already connected / USB线缆已连接");
		/* Display initial status on A6N screen / 在A6N屏幕上显示初始状态 */
		display_update_xy_text(350, 20, "[USB: ON]", 48, 0xFFFFFF);
	}
	else
	{
		usb_connected = false;
		LOG_INF("🔌 USB cable not connected / USB线缆未连接");
		/* Display initial status on A6N screen / 在A6N屏幕上显示初始状态 */
		display_update_xy_text(350, 20, "[USB: OFF]", 48, 0xFFFFFF);
	}
	
	/* Start polling / 开始轮询 */
	k_work_schedule(&usb_detect_work, K_MSEC(USB_DETECT_POLL_INTERVAL_MS));
	
	LOG_INF("✅ USB detection started / USB检测已启动");
	
	return 0;
}

/**
 * @brief Query USB cable connection status

 * Returns the current USB connection status.
 * Status is updated every second by the polling task.
 * 
 * 返回当前USB连接状态。
 * 状态由轮询任务每秒更新一次。
 * 
 * @return true if USB cable is connected / USB线缆已连接返回true
 * @return false if USB cable is disconnected / USB线缆已断开返回false
 */
bool usb_is_connected(void)
{
	return usb_connected;
}

static void setup_dynamic_advertising(void)
{
	bt_addr_le_t addr;
	size_t count = 1;
	
	// Get the device address
	bt_id_get(&addr, &count);
	
	// Create device name with MAC suffix (last 6 hex digits)
	snprintf(dynamic_device_name, sizeof(dynamic_device_name), 
		 "Nex1-%02X%02X%02X", 
		 addr.a.val[2], addr.a.val[1], addr.a.val[0]);
	
	LOG_INF("Device name: %s", dynamic_device_name);
	
	// Set the Bluetooth device name
	int err = bt_set_name(dynamic_device_name);
	if (err) {
		LOG_ERR("Failed to set device name (err %d)", err);
	}
	
	// Update the advertising data with the new name
	ad[1].data = (const uint8_t *)dynamic_device_name;
	ad[1].data_len = strlen(dynamic_device_name);
}

const char *get_ble_device_name(void)
{
	return dynamic_device_name;
}

#ifdef CONFIG_UART_ASYNC_ADAPTER
UART_ASYNC_ADAPTER_INST_DEFINE(async_adapter);
#else
#define async_adapter NULL
#endif

static void uart_cb(const struct device *dev, struct uart_event *evt, void *user_data)
{
	ARG_UNUSED(dev);

	static size_t aborted_len;
	struct uart_data_t *buf;
	static uint8_t *aborted_buf;
	static bool disable_req;

	switch (evt->type) {
	case UART_TX_DONE:
		LOG_DBG("UART_TX_DONE");
		if ((evt->data.tx.len == 0) ||
		    (!evt->data.tx.buf)) {
			return;
		}

		if (aborted_buf) {
			buf = CONTAINER_OF(aborted_buf, struct uart_data_t,
					   data[0]);
			aborted_buf = NULL;
			aborted_len = 0;
		} else {
			buf = CONTAINER_OF(evt->data.tx.buf, struct uart_data_t,
					   data[0]);
		}

		k_free(buf);

		buf = k_fifo_get(&fifo_uart_tx_data, K_NO_WAIT);
		if (!buf) {
			return;
		}

		if (uart_tx(uart, buf->data, buf->len, SYS_FOREVER_MS)) {
			LOG_WRN("Failed to send data over UART");
		}

		break;

	case UART_RX_RDY:
		LOG_DBG("UART_RX_RDY");
		buf = CONTAINER_OF(evt->data.rx.buf, struct uart_data_t, data[0]);
		buf->len += evt->data.rx.len;

		if (disable_req) {
			return;
		}

		if ((evt->data.rx.buf[buf->len - 1] == '\n') ||
		    (evt->data.rx.buf[buf->len - 1] == '\r')) {
			disable_req = true;
			uart_rx_disable(uart);
		}

		break;

	case UART_RX_DISABLED:
		LOG_DBG("UART_RX_DISABLED");
		disable_req = false;

		buf = k_malloc(sizeof(*buf));
		if (buf) {
			buf->len = 0;
		} else {
			LOG_WRN("Not able to allocate UART receive buffer");
			k_work_reschedule(&uart_work, UART_WAIT_FOR_BUF_DELAY);
			return;
		}

		uart_rx_enable(uart, buf->data, sizeof(buf->data),
			       UART_WAIT_FOR_RX);

		break;

	case UART_RX_BUF_REQUEST:
		LOG_DBG("UART_RX_BUF_REQUEST");
		buf = k_malloc(sizeof(*buf));
		if (buf) {
			buf->len = 0;
			uart_rx_buf_rsp(uart, buf->data, sizeof(buf->data));
		} else {
			LOG_WRN("Not able to allocate UART receive buffer");
		}

		break;

	case UART_RX_BUF_RELEASED:
		LOG_DBG("UART_RX_BUF_RELEASED");
		buf = CONTAINER_OF(evt->data.rx_buf.buf, struct uart_data_t,
				   data[0]);

		if (buf->len > 0) {
			k_fifo_put(&fifo_uart_rx_data, buf);
		} else {
			k_free(buf);
		}

		break;

	case UART_TX_ABORTED:
		LOG_DBG("UART_TX_ABORTED");
		if (!aborted_buf) {
			aborted_buf = (uint8_t *)evt->data.tx.buf;
		}

		aborted_len += evt->data.tx.len;
		buf = CONTAINER_OF((void *)aborted_buf, struct uart_data_t,
				   data);

		uart_tx(uart, &buf->data[aborted_len],
			buf->len - aborted_len, SYS_FOREVER_MS);

		break;

	default:
		break;
	}
}

static void uart_work_handler(struct k_work *item)
{
	struct uart_data_t *buf;

	buf = k_malloc(sizeof(*buf));
	if (buf) {
		buf->len = 0;
	} else {
		LOG_WRN("Not able to allocate UART receive buffer");
		k_work_reschedule(&uart_work, UART_WAIT_FOR_BUF_DELAY);
		return;
	}

	uart_rx_enable(uart, buf->data, sizeof(buf->data), UART_WAIT_FOR_RX);
}

static bool uart_test_async_api(const struct device *dev)
{
#ifdef CONFIG_UART_ASYNC_API
	const struct uart_driver_api *api =
			(const struct uart_driver_api *)dev->api;
	return (api->callback_set != NULL);
#else
	ARG_UNUSED(dev);
	return false;
#endif
}

static int uart_init(void)
{
	int err;
	int pos;
	struct uart_data_t *rx;
	struct uart_data_t *tx;

	if (!device_is_ready(uart)) {
		return -ENODEV;
	}

	if (IS_ENABLED(CONFIG_USB_DEVICE_STACK)) {
		err = usb_enable(NULL);
		if (err && (err != -EALREADY)) {
			LOG_ERR("Failed to enable USB");
			return err;
		}
	}

	rx = k_malloc(sizeof(*rx));
	if (rx) {
		rx->len = 0;
	} else {
		return -ENOMEM;
	}

	k_work_init_delayable(&uart_work, uart_work_handler);


	if (IS_ENABLED(CONFIG_UART_ASYNC_ADAPTER) && !uart_test_async_api(uart)) {
		/* Implement API adapter */
		uart_async_adapter_init(async_adapter, uart);
		uart = async_adapter;
	}

	err = uart_callback_set(uart, uart_cb, NULL);
	if (err) {
		k_free(rx);
		LOG_ERR("Cannot initialize UART callback");
		return err;
	}

	if (IS_ENABLED(CONFIG_UART_LINE_CTRL)) {
		LOG_INF("Wait for DTR");
		while (true) {
			uint32_t dtr = 0;

			uart_line_ctrl_get(uart, UART_LINE_CTRL_DTR, &dtr);
			if (dtr) {
				break;
			}
			/* Give CPU resources to low priority threads. */
			k_sleep(K_MSEC(100));
		}
		LOG_INF("DTR set");
		err = uart_line_ctrl_set(uart, UART_LINE_CTRL_DCD, 1);
		if (err) {
			LOG_WRN("Failed to set DCD, ret code %d", err);
		}
		err = uart_line_ctrl_set(uart, UART_LINE_CTRL_DSR, 1);
		if (err) {
			LOG_WRN("Failed to set DSR, ret code %d", err);
		}
	}

	tx = k_malloc(sizeof(*tx));

	if (tx) {
		pos = snprintf(tx->data, sizeof(tx->data),
			       "🚀 v2.2.0-DISPLAY_OPEN_FIX\r\n"
			       "📊 LVGL Test Pattern\r\n"
			       " display_open() added!\r\n"
			       "Ready!\r\n"
			       "====================\r\n");

		if ((pos < 0) || (pos >= sizeof(tx->data))) {
			k_free(rx);
			k_free(tx);
			LOG_ERR("snprintf returned %d", pos);
			return -ENOMEM;
		}

		tx->len = pos;
	} else {
		k_free(rx);
		return -ENOMEM;
	}

	err = uart_tx(uart, tx->data, tx->len, SYS_FOREVER_MS);
	if (err) {
		k_free(rx);
		k_free(tx);
		LOG_ERR("Cannot display welcome message (err: %d)", err);
		return err;
	}

	err = uart_rx_enable(uart, rx->data, sizeof(rx->data), UART_WAIT_FOR_RX);
	if (err) {
		LOG_ERR("Cannot enable uart reception (err: %d)", err);
		/* Free the rx buffer only because the tx buffer will be handled in the callback */
		k_free(rx);
	}

	return err;
}

static void adv_work_handler(struct k_work *work)
{
	// Setup dynamic advertising
	setup_dynamic_advertising();
	
	LOG_INF("Starting advertising with:");
	LOG_INF("  Device name: %s", dynamic_device_name);
	LOG_INF("  Service UUID: 00004860-0000-1000-8000-00805f9b34fb");
	LOG_INF("  Ad data entries: %d, Scan data entries: %d", ARRAY_SIZE(ad), ARRAY_SIZE(sd));
	
	int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_2, ad, 2, sd, 1);

	if (err) {
		LOG_ERR("Advertising failed to start (err %d)", err);
		return;
	}

	LOG_INF("Advertising successfully started with device name: %s", dynamic_device_name);
}

static void advertising_start(void)
{
	k_work_submit(&adv_work);
}
void set_ble_connected_status(bool connected)
{
    ble_connected = connected;
}
bool get_ble_connected_status(void)
{
    return ble_connected;
}
static void connected(struct bt_conn *conn, uint8_t err)
{
	char addr[BT_ADDR_LE_STR_LEN];

	if (err) {
		LOG_ERR("Connection failed, err 0x%02x %s", err, bt_hci_err_to_str(err));
		return;
	}

	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));
	LOG_INF("Connected %s", addr);
	set_ble_connected_status(true);
	current_conn = bt_conn_ref(conn);
	dk_set_led_on(CON_STATUS_LED);
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
	char addr[BT_ADDR_LE_STR_LEN];

	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));
	
	LOG_INF("Disconnected: %s, reason 0x%02x %s", addr, reason, bt_hci_err_to_str(reason));
	set_ble_connected_status(false);
	if (auth_conn) {
		bt_conn_unref(auth_conn);
		auth_conn = NULL;
	}

	if (current_conn) {
		bt_conn_unref(current_conn);
		current_conn = NULL;
		dk_set_led_off(CON_STATUS_LED);
	}
}

static void recycled_cb(void)
{
	LOG_INF("Connection object available from previous conn. Disconnect is complete!");
	advertising_start();
}

#ifdef CONFIG_BT_NUS_SECURITY_ENABLED
static void security_changed(struct bt_conn *conn, bt_security_t level,
			     enum bt_security_err err)
{
	char addr[BT_ADDR_LE_STR_LEN];

	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

	if (!err) {
		LOG_INF("Security changed: %s level %u", addr, level);
	} else {
		LOG_WRN("Security failed: %s level %u err %d %s", addr, level, err,
			bt_security_err_to_str(err));
	}
}
#endif

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected        = connected,
	.disconnected     = disconnected,
	.recycled         = recycled_cb,
#ifdef CONFIG_BT_NUS_SECURITY_ENABLED
	.security_changed = security_changed,
#endif
};

#if defined(CONFIG_BT_NUS_SECURITY_ENABLED)
static void auth_passkey_display(struct bt_conn *conn, unsigned int passkey)
{
	char addr[BT_ADDR_LE_STR_LEN];

	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

	LOG_INF("Passkey for %s: %06u", addr, passkey);
}

static void auth_passkey_confirm(struct bt_conn *conn, unsigned int passkey)
{
	char addr[BT_ADDR_LE_STR_LEN];

	auth_conn = bt_conn_ref(conn);

	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

	LOG_INF("Passkey for %s: %06u", addr, passkey);

	if (IS_ENABLED(CONFIG_SOC_SERIES_NRF54HX) || IS_ENABLED(CONFIG_SOC_SERIES_NRF54LX)) {
		LOG_INF("Press Button 0 to confirm, Button 1 to reject.");
	} else {
		LOG_INF("Press Button 1 to confirm, Button 2 to reject.");
	}
}


static void auth_cancel(struct bt_conn *conn)
{
	char addr[BT_ADDR_LE_STR_LEN];

	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

	LOG_INF("Pairing cancelled: %s", addr);
}


static void pairing_complete(struct bt_conn *conn, bool bonded)
{
	char addr[BT_ADDR_LE_STR_LEN];

	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

	LOG_INF("Pairing completed: %s, bonded: %d", addr, bonded);
}


static void pairing_failed(struct bt_conn *conn, enum bt_security_err reason)
{
	char addr[BT_ADDR_LE_STR_LEN];

	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

	LOG_INF("Pairing failed conn: %s, reason %d %s", addr, reason,
		bt_security_err_to_str(reason));
}

static struct bt_conn_auth_cb conn_auth_callbacks = {
	.passkey_display = auth_passkey_display,
	.passkey_confirm = auth_passkey_confirm,
	.cancel = auth_cancel,
};

static struct bt_conn_auth_info_cb conn_auth_info_callbacks = {
	.pairing_complete = pairing_complete,
	.pairing_failed = pairing_failed
};
#else
static struct bt_conn_auth_cb conn_auth_callbacks;
static struct bt_conn_auth_info_cb conn_auth_info_callbacks;
#endif

static void bt_receive_cb(struct bt_conn *conn, const uint8_t *const data,
			  uint16_t len)
{
	char addr[BT_ADDR_LE_STR_LEN] = {0};

	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, ARRAY_SIZE(addr));

	LOG_INF("Received data from: %s", addr);

	// Analyze the protobuf message and send to LVGL display
	protobuf_analyze_message(data, len);

	// Generate and send echo response
	uint8_t echo_buffer[128];
	int echo_len = protobuf_generate_echo_response(data, len, echo_buffer, sizeof(echo_buffer));
	
	if (echo_len > 0) {
		LOG_INF("🔄 Attempting to send echo response (%d bytes)...", echo_len);
		int err = mentra_ble_send(conn, echo_buffer, echo_len);
		if (err) {
			LOG_ERR("❌ Failed to send echo response: %d (likely notification subscription issue)", err);
		} else {
			LOG_INF("✅ Sent echo response successfully: %s", echo_buffer);
		}
	} else {
		LOG_WRN("⚠️ No echo response generated (echo_len = %d)", echo_len);
	}
#if 0
	// Also forward to UART for debugging
	for (uint16_t pos = 0; pos != len;) {
		struct uart_data_t *tx = k_malloc(sizeof(*tx));

		if (!tx) {
			LOG_WRN("Not able to allocate UART send data buffer");
			return;
		}

		/* Keep the last byte of TX buffer for potential LF char. */
		size_t tx_data_size = sizeof(tx->data) - 1;

		if ((len - pos) > tx_data_size) {
			tx->len = tx_data_size;
		} else {
			tx->len = (len - pos);
		}

		memcpy(tx->data, &data[pos], tx->len);

		pos += tx->len;

		/* Append the LF character when the CR character triggered
		 * transmission from the peer.
		 */
		if ((pos == len) && (data[len - 1] == '\r')) {
			tx->data[tx->len] = '\n';
			tx->len++;
		}

		int err = uart_tx(uart, tx->data, tx->len, SYS_FOREVER_MS);
		if (err) {
			k_fifo_put(&fifo_uart_tx_data, tx);
		}
	}
#endif
}

static struct mentra_ble_cb mentra_cb = {
	.received = bt_receive_cb,
};
uint16_t get_ble_payload_mtu(void)
{
    return payload_mtu;
}
void mtu_updated(struct bt_conn *conn, uint16_t tx, uint16_t rx)
{
    payload_mtu = bt_gatt_get_mtu(conn) - 3;  // 3 bytes used for Attribute headers.
    LOG_INF("Updated MTU: TX: %d RX: %d bytes", tx, rx);
    LOG_INF("Updated MTU: %d; Payload=[%d] ", payload_mtu + 3, payload_mtu);
}
static struct bt_gatt_cb gatt_callbacks = 
{
	.att_mtu_updated = mtu_updated
};

/**
 * @brief ble send data function
 * @param data Pointer to the data to send
 * @param len Length of the data to send
 * @return 0 on success, -1 on failure
 */
int ble_send_data(const uint8_t *data, uint16_t len)
{
    if ((!data || len == 0) || !get_ble_connected_status())
    // if ((!data || len == 0))
    {
        // LOG_ERR("Invalid data or length || ble not connected");
        return -1;
    }
    // LOG_INF("<--Sending data to BLE-->: len=%d", len);
    // LOG_INF("Data: %s", data);
    // LOG_HEXDUMP_INF(data, len, "Hexdump:");
    uint16_t offset = 0;
    uint16_t mtu    = get_ble_payload_mtu();
    while (offset < len)
    {
        uint16_t chunk_len = MIN(len - offset, mtu);
        int      retry     = 0;
        int      err;
        do
        {
            err = mentra_ble_send(NULL, &data[offset], chunk_len);
            if (err == 0)
                break;
            LOG_ERR(" Chunk send failed (offset=%u len=%u), retry %d", offset, chunk_len, retry);
        } while (++retry < 3);  // max 3 retries
        // LOG_HEXDUMP_INF( &data[offset], chunk_len, "Hexdump:");
        if (err != 0)
        {
            LOG_ERR("Final failure at offset=%u", offset);
            return -1;
        }
        offset += chunk_len;
        k_msleep(1);  // delay 2ms to avoid flooding the BLE interface
    }

    return 0;
}
void error(void)
{
	dk_set_leds_state(DK_ALL_LEDS_MSK, DK_NO_LEDS_MSK);

	while (true) {
		/* Spin for ever */
		k_sleep(K_MSEC(1000));
	}
}

#ifdef CONFIG_BT_NUS_SECURITY_ENABLED
static void num_comp_reply(bool accept)
{
	if (accept) {
		bt_conn_auth_passkey_confirm(auth_conn);
		LOG_INF("Numeric Match, conn %p", (void *)auth_conn);
	} else {
		bt_conn_auth_cancel(auth_conn);
		LOG_INF("Numeric Reject, conn %p", (void *)auth_conn);
	}

	bt_conn_unref(auth_conn);
	auth_conn = NULL;
}
#endif /* CONFIG_BT_NUS_SECURITY_ENABLED */

void button_changed(uint32_t button_state, uint32_t has_changed)
{
	uint32_t buttons = button_state & has_changed;

	// **DEBUG: Enhanced button logging to identify spurious events**
	if ((has_changed != 0) && !(has_changed & (DK_BTN3_MSK | DK_BTN4_MSK))) // Ignore spurious changes on Button 3/4
	{
		LOG_INF("� Button Event: state=0x%02X, changed=0x%02X, pressed=0x%02X", 
		        button_state, has_changed, buttons);
	}

#ifdef CONFIG_BT_NUS_SECURITY_ENABLED
	if (auth_conn) {
		// Handle authentication buttons when in authentication mode
		if (buttons & KEY_PASSKEY_ACCEPT) {
			num_comp_reply(true);
		}

		if (buttons & KEY_PASSKEY_REJECT) {
			num_comp_reply(false);
		}
		return; // Don't handle other buttons during authentication
	}
#endif /* CONFIG_BT_NUS_SECURITY_ENABLED */

	// **NEW: Button combination for pattern cycling (Button 1 + Button 2)**
	if ((button_state & KEY_PATTERN_CYCLE) == KEY_PATTERN_CYCLE && 
	    (has_changed & (DK_BTN1_MSK | DK_BTN2_MSK))) {
		LOG_INF("🎨 Button combo 1+2: Cycling LVGL test patterns");
		display_cycle_pattern();
		return; // Don't process individual button presses when combination is active
	}

	// **NEW: Button 1 alone - Cycle battery level 0→100% and toggle charging**
	if (buttons & KEY_BATTERY_CYCLE && !(button_state & DK_BTN2_MSK)) {
		static uint8_t battery_level = 0;
		static bool charging_state = false;
		
		// Cycle battery: 0→20→40→60→80→100→0...
		battery_level += 20;
		if (battery_level > 100) {
			battery_level = 0;
		}
		
		// Toggle charging state each cycle
		charging_state = !charging_state;
		
		protobuf_set_battery_level(battery_level);
		protobuf_set_charging_state(charging_state);
		
		LOG_INF("🔋 Button 1: Battery %u%%, charging: %s", 
		        battery_level, charging_state ? "ON" : "OFF");
		return;
	}

	// **NEW: Button 2 alone - Cycle through LVGL test patterns**
	if (buttons & KEY_SCREEN_TOGGLE && !(button_state & DK_BTN1_MSK)) {
		LOG_INF("🎨 Button 2: Cycling LVGL test patterns");
		display_cycle_pattern();
		return;
	}

	// **DISABLED: Buttons 3 & 4 are ignored due to SPI4 conflicts**
	if (has_changed & (DK_BTN3_MSK | DK_BTN4_MSK)) {
		// LOG_WRN("⚠️  Buttons 3/4 disabled (SPI4 conflict on P0.08/P0.09)");
	}
}

static void configure_gpio(void)
{
	int err;

	// Always initialize buttons for battery level control
	err = dk_buttons_init(button_changed);
	if (err) {
		LOG_ERR("Cannot init buttons (err: %d)", err);
	}

	err = dk_leds_init();
	if (err) {
		LOG_ERR("Cannot init LEDs (err: %d)", err);
	}
}

// External BSP log control
extern void bsp_log_init(void);
extern int bsp_log_runtime_level;

/**
 * @brief Initialize user GPIOs (ES power and Microphone power)
 * @return 0 on success, negative value on error
 */
#define USER_NODE DT_PATH(zephyr_user)

#if DT_NODE_EXISTS(USER_NODE)
static const struct gpio_dt_spec es_power_en = GPIO_DT_SPEC_GET(USER_NODE, es_power_en_gpios);
static const struct gpio_dt_spec mic_pwr_en = GPIO_DT_SPEC_GET(USER_NODE, mic_pwr_en_gpios);

int init_user_gpio(void)
{
	int err;
	
	if (!gpio_is_ready_dt(&es_power_en))
	{
		LOG_ERR("GPIO port for es_power_en not ready");
		return -1;
	}
	
	err = gpio_pin_configure_dt(&es_power_en, GPIO_OUTPUT_HIGH | GPIO_PULL_UP);
	if (err != 0)
	{
		LOG_ERR("es_power_en config error: %d", err);
		return err;
	}
	
	if (!gpio_is_ready_dt(&mic_pwr_en))
	{
		LOG_ERR("GPIO mic_pwr_en not ready");
		return -1;
	}
	
	err = gpio_pin_configure_dt(&mic_pwr_en, GPIO_OUTPUT_HIGH | GPIO_PULL_UP);
	if (err != 0)
	{
		LOG_ERR("mic_pwr_en config error: %d", err);
		return err;
	}
	
	LOG_INF("User GPIOs configured successfully");
	return 0;
}
#else
int init_user_gpio(void)
{
	LOG_WRN("zephyr,user node not defined, skipping user GPIO initialization");
	return 0;
}
#endif

int main(void)
{
	int blink_status = 0;
	int err = 0;

	// Initialize BSP logging with disabled defaults (level 0 = DISABLED)
	bsp_log_init();
	
	// Set Zephyr log level to ERROR only for very clean startup  
	// Note: Use built-in 'log' shell commands for runtime control instead

	LOG_INF("🚀🚀🚀 MAIN FUNCTION STARTED - v2.2.0-DISPLAY_OPEN_FIX 🚀🚀🚀");
	LOG_INF("🌟🌟🌟 MAIN FUNCTION LOG_INF - v2.2.0-DISPLAY_OPEN_FIX 🌟🌟🌟\n");

	// Initialize user GPIOs (ES power and Microphone power from A6M)
	err = init_user_gpio();
	if (err != 0)
	{
		LOG_ERR("Failed to initialize user GPIOs: %d", err);
	}

	configure_gpio();

	// **NEW: Log updated button functionality (avoiding SPI4 conflicts)**
	LOG_INF("� Button controls updated (avoiding SPI4 pin conflicts):");
	LOG_INF("   � Button 1: Cycle battery 0→100%% + toggle charging");
	LOG_INF("   🎨 Button 2: Cycle LVGL test patterns");
	LOG_INF("   🎨 Button 1+2: Cycle LVGL test patterns (same as Button 2)");
	LOG_INF("   ⚠️  Buttons 3&4 disabled (SPI4 conflict P0.08/P0.09)");
	LOG_INF("   � Current battery level: %u%%", protobuf_get_battery_level());

	// Initialize brightness control
	LOG_INF("💡 LED 3 brightness control enabled:");
	LOG_INF("   📱 Mobile app can set brightness level (0-100%%)");
	LOG_INF("   📊 Current brightness level: %u%%", protobuf_get_brightness_level());
	
	// Set initial brightness to 50%
	protobuf_set_brightness_level(50);

	// err = uart_init();
	// if (err) {
	// 	error();
	// }

	if (IS_ENABLED(CONFIG_BT_NUS_SECURITY_ENABLED)) {
		err = bt_conn_auth_cb_register(&conn_auth_callbacks);
		if (err) {
			LOG_ERR("Failed to register authorization callbacks. (err: %d)", err);
			return 0;
		}

		err = bt_conn_auth_info_cb_register(&conn_auth_info_callbacks);
		if (err) {
			LOG_ERR("Failed to register authorization info callbacks. (err: %d)", err);
			return 0;
		}
	}

	err = bt_enable(NULL);
	if (err) {
		error();
	}
	
	LOG_INF("Bluetooth initialized");

	k_sem_give(&ble_init_ok);

	if (IS_ENABLED(CONFIG_SETTINGS)) {
		settings_load();
	}

	err = mentra_ble_init(&mentra_cb);
	if (err) {
		LOG_ERR("Failed to initialize Mentra BLE service (err: %d)", err);
		return 0;
	}
	bt_gatt_cb_register(&gatt_callbacks);
	// Initialize PDM audio streaming system
	LOG_INF("🎤 Initializing PDM audio streaming system...");
	err = pdm_audio_stream_init();
	if (err) {
		LOG_ERR("Failed to initialize PDM audio streaming (err: %d)", err);
		// Continue without audio streaming capability
	} else {
		LOG_INF("✅ PDM audio streaming system ready");
		LOG_INF("📱 Mobile app can enable/disable microphone via MicStateConfig (Tag 20)");
	}

	// Initialize ping/pong connectivity monitoring system
	LOG_INF("📡 Initializing ping/pong connectivity monitoring...");
	protobuf_init_ping_monitoring();
	LOG_INF("✅ Ping monitoring started - glasses will ping phone every 10 seconds");
	LOG_INF("📱 Phone should respond with pong messages to maintain connection");

	// Initialize LVGL display system with working driver implementation
	LOG_INF("🔥🔥🔥 About to initialize LVGL display system... 🔥🔥🔥\n");
	
	// Start the LVGL display thread first!
	LOG_INF("🧵 Starting LVGL display thread...");
	lvgl_display_thread();
	LOG_INF("✅ LVGL display thread started!");
#if 0
        // Give the thread a moment to initialize
        k_msleep(100);
        
        // Send LCD_CMD_OPEN to start the LVGL display system
        LOG_INF("📡📡📡 Calling display_open() NOW... 📡📡📡\n");
        display_open();
        LOG_INF("✅ display_open() call completed!");
        
        // Add direct A6N test from main thread
        LOG_INF("🖥️ Testing A6N display from main thread...");
        const struct device *test_disp = DEVICE_DT_GET(DT_CHOSEN(zephyr_display));
        if (device_is_ready(test_disp)) {
            LOG_INF("✅ A6N device ready in main: %s", test_disp->name);
            
            // Try to turn off blanking
            int ret = display_blanking_off(test_disp);
            LOG_INF("📺 Display blanking off result: %d", ret);
            
            // Try a simple write operation
            uint8_t test_data[8] = {0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00};
            struct display_buffer_descriptor desc = {
                .buf_size = 8,
                .width = 4,
                .height = 1,
                .pitch = 4,
            };
            
            ret = display_write(test_disp, 0, 0, &desc, test_data);
            LOG_INF("🎨 Display write result: %d", ret);
            
            if (ret == 0) {
                LOG_INF("🎉 SUCCESS: A6N write operation completed!");
            } else {
                LOG_ERR("❌ FAILED: A6N write operation failed: %d", ret);
            }
        } else {
            LOG_ERR("❌ A6N device not ready in main");
        }
        
        // The LVGL demo thread is already defined in lvgl_demo.c - no need to call it here
        LOG_INF("LVGL demo thread will start automatically");
#endif
	k_work_init(&adv_work, adv_work_handler);
	advertising_start();
	opt3006_initialize();
	pm1300_init();
	lsm6dsv16x_init();
	// usb_detect_init();
	npm1300_led_init();
	
	for (;;) 
	{
		dk_set_led(RUN_STATUS_LED, (++blink_status) % 2);
		k_sleep(K_MSEC(RUN_LED_BLINK_INTERVAL));
	}
}

void ble_write_thread(void)
{
	/* Don't go any further until BLE is initialized */
	k_sem_take(&ble_init_ok, K_FOREVER);
	struct uart_data_t mentra_data = 
	{
		.len = 0,
	};

	for (;;) {
		/* Wait indefinitely for data to be sent over bluetooth */
		struct uart_data_t *buf = k_fifo_get(&fifo_uart_rx_data,
						     K_FOREVER);

		int plen = MIN(sizeof(mentra_data.data) - mentra_data.len, buf->len);
		int loc = 0;

		while (plen > 0) {
			memcpy(&mentra_data.data[mentra_data.len], &buf->data[loc], plen);
			mentra_data.len += plen;
			loc += plen;

			if (mentra_data.len >= sizeof(mentra_data.data) ||
			   (mentra_data.data[mentra_data.len - 1] == '\n') ||
			   (mentra_data.data[mentra_data.len - 1] == '\r')) {
				if (mentra_ble_send(current_conn, mentra_data.data, mentra_data.len)) {
					LOG_WRN("Failed to send data over BLE connection");
				}
				mentra_data.len = 0;
			}

			plen = MIN(sizeof(mentra_data.data), buf->len - loc);
		}

		k_free(buf);
	}
}

K_THREAD_DEFINE(ble_write_thread_id, STACKSIZE, ble_write_thread, NULL, NULL,
		NULL, PRIORITY, 0, 0);



static int hfclock_config_and_start(void)
{
	int ret;
	/* Use this to turn on 128 MHz clock for cpu_app */
	ret = nrfx_clock_divider_set(NRF_CLOCK_DOMAIN_HFCLK, NRF_CLOCK_HFCLK_DIV_1);
	ret -= NRFX_ERROR_BASE_NUM;
	if (ret)
	{
		return ret;
	}
	nrfx_clock_hfclk_start();
	while (!nrfx_clock_hfclk_is_running())
	{
	}
	return 0;
}
SYS_INIT(hfclock_config_and_start, POST_KERNEL, 0);
