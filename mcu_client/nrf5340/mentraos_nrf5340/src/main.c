/*
 * @Author       : Cole
 * @Date         : 2025-07-25 11:26:39
 * @LastEditTime : 2025-07-30 16:45:53
 * @FilePath     : main.c
 * @Description  : 
 * 
 * Copyright (c) 2025 MentraOS Organization. All rights reserved.
 */


#include <uart_async_adapter.h>

#include <zephyr/types.h>
#include <zephyr/kernel.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/usb/usb_device.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <soc.h>

#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/gap.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>

// #include <bluetooth/services/nus.h>
#include <zephyr/settings/settings.h>

#include <stdio.h>
#include <string.h>
#include <zephyr/logging/log.h>
/******************************************* */
#include "nrfx_clock.h"
#include "bsp_log.h"
#include "xyzn_config.h"
#include "main.h"
#include "task_ble_receive.h"
#include "xyzn_ble_service.h"
#include "bsp_board_mcu.h"
#include "protocol_ble_send.h"
#include "protocol_ble_process.h"
#include "protocol_image_cache.h"
#include "xyzn_lvgl_display.h"
#include "task_process.h"
#include "task_interrupt.h"
#include "bspal_watchdog.h"
#include "task_lc3_codec.h"
#define TAG "MAIN"

static struct bt_conn *my_current_conn;

static uint16_t payload_mtu = 20;  // 默认MTU长度
static bool ble_connected = false; // 默认未连接
#define BLE_NAME_MAX_LEN 20
static uint8_t device_name[BLE_NAME_MAX_LEN] = "1234567890";

#define BT_GAP_PER_ADV_MS_TO_INTERVAL(ms) ((ms) * 1000 / 625)

static struct bt_le_adv_param g_adv_param;

#define BLE_AD_IDX_FLAGS 0
#define BLE_AD_IDX_NAME 1
#define BLE_AD_IDX_XY_TEST 2
static uint8_t xyzn_test_ad_data[11] = {0x4B, 0X39, 0X30, 0X30, 0X30, 0X30, 0X30, 0X30, 0X30, 0X30, 0X30};
static uint8_t xyzn_test_sd_data[11] = {0x22, 0XB8, 0X00, 0X08, 0XFF, 0X01, 0X30, 0X30, 0X30, 0X30, 0X30};
/******************************************* */

#define LOG_MODULE_NAME main
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

static K_SEM_DEFINE(ble_init_ok, 0, 1);

static struct bt_conn *auth_conn;
static struct k_work adv_work;

static struct bt_data ad[] = {
	[BLE_AD_IDX_FLAGS] = BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	[BLE_AD_IDX_NAME] = BT_DATA(BT_DATA_NAME_COMPLETE, device_name, (sizeof(device_name) - 1)),
	// [BLE_AD_IDX_XY_TEST] = BT_DATA(BT_DATA_GAP_APPEARANCE, xyzn_test_ad_data, (sizeof(xyzn_test_ad_data) - 1)), // test
};

static const struct bt_data sd[] = {
	// BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_MY_SERVICE_VAL),
	BT_DATA(BT_DATA_MANUFACTURER_DATA, xyzn_test_sd_data, (sizeof(xyzn_test_sd_data) - 1)), // test
};

#ifdef CONFIG_UART_ASYNC_ADAPTER
UART_ASYNC_ADAPTER_INST_DEFINE(async_adapter);
#else
#define async_adapter NULL
#endif
void ble_init_sem_give(void)
{
	k_sem_give(&ble_init_ok); // 通知蓝牙初始化完成
}
/**
 * @description: 等待蓝牙初始化完成
 * @return int 0:成功，其他:失败
 */
int ble_init_sem_take(void)
{
	return k_sem_take(&ble_init_ok, K_FOREVER);
}
void adv_set_ble_name(const uint8_t *data, uint8_t data_len)
{
	if (data_len < sizeof(device_name))
	{
		memset(device_name, 0, sizeof(device_name));
		memcpy(device_name, data, data_len);

		ad[BLE_AD_IDX_NAME].data = device_name;
		ad[BLE_AD_IDX_NAME].data_len = data_len;
		BSP_LOGI(TAG, "Set BLE name to[%d]: %s", data_len, device_name);
	}
	else
	{
		BSP_LOGW(TAG, "Name too long to set in adv");
	}
}
void ble_name_update_data(const char *name)
{
	if (name == NULL || strlen(name) > BLE_NAME_MAX_LEN)
	{
		BSP_LOGE(TAG, "Invalid name provided ERR");
		return;
	}
	char ble_name[BLE_NAME_MAX_LEN + 1];
	memset(ble_name, 0, sizeof(ble_name));
	strncpy(ble_name, name, strlen(name));

	BSP_LOGI(TAG, "Updating BLE name to: %s", ble_name);
	int err = bt_set_name(ble_name);
	if (err != 0)
	{
		BSP_LOGE(TAG, "Failed to set name (err %d)", err);
		return;
	}
	adv_set_ble_name((const uint8_t *)ble_name, strlen(ble_name));

	err = bt_le_adv_update_data(ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
	if (err != 0)
	{
		LOG_ERR("Failed to update adv data (err %d)", err);
	}
}
void get_ble_mac_addr(uint8_t *mac_addr, uint8_t mac_addr_len)
{
	if ((mac_addr == NULL) || (mac_addr_len < BT_ADDR_LE_STR_LEN))
	{
		BSP_LOGE(TAG, "Invalid mac_addr provided err");
		return;
	}
	bt_addr_le_t addr;
	size_t count = 1;
	bt_id_get(&addr, &count);

	char addr_str[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(&addr, addr_str, sizeof(addr_str));
	// snprintf((char *)mac_addr, 17, "%s", addr_str); // CF:53:47:E4:94:88
	memcpy((uint8_t *)mac_addr, addr_str, 17);
	BSP_LOGI(TAG, "Bluetooth address:%s", addr_str);
}
static void adv_work_handler(struct k_work *work)
{
	int err;
	int retry;
	for (retry = 0; retry < 5; retry++) // 累计尝试5次
	{
		err = bt_le_adv_start(&g_adv_param, ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
		if (err == 0)
		{
			LOG_INF("Advertising successfully started (try %d)", retry + 1);
			return;
		}
		LOG_ERR("Advertising failed to start (err %d), try %d", err, retry + 1);
		// 如果不是第一次，尝试 stop 再 start
		if (retry > 0)
		{
			int stop_err = bt_le_adv_stop();
			if (stop_err != 0)
			{
				LOG_ERR("Advertising failed to stop (err %d)", stop_err);
			}
		}
		xyzn_os_delay_ms(20); // 短暂等待后再重试
	}
	LOG_ERR("Advertising failed to start after %d retries", retry);
}

void advertising_start(void)
{
	k_work_submit(&adv_work); // 向系统队列提交工作项目
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

	if (!err)
	{
		LOG_INF("Security changed: %s level %u", addr, level);
	}
	else
	{
		LOG_WRN("Security failed: %s level %u err %d %s", addr, level, err,
				bt_security_err_to_str(err));
	}
}
#endif

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

	if (IS_ENABLED(CONFIG_SOC_SERIES_NRF54HX) || IS_ENABLED(CONFIG_SOC_SERIES_NRF54LX))
	{
		LOG_INF("Press Button 0 to confirm, Button 1 to reject.");
	}
	else
	{
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
	.pairing_failed = pairing_failed};
#else
static struct bt_conn_auth_cb conn_auth_callbacks;
static struct bt_conn_auth_info_cb conn_auth_info_callbacks;
#endif
static void bt_receive_cb(struct bt_conn *conn,
						  const uint8_t *const data,
						  uint16_t len)
{
	// char addr[BT_ADDR_LE_STR_LEN] = {0};
	// bt_addr_le_to_str(bt_conn_get_dst(conn), addr, ARRAY_SIZE(addr));
	// LOG_INF("Received data from: %s", addr);
	ble_receive_fragment(data, len);
}

static void update_data_length(struct bt_conn *conn)
{
	int err;
	struct bt_conn_le_data_len_param my_data_len =
		{
			.tx_max_len = BT_GAP_DATA_LEN_MAX,
			.tx_max_time = BT_GAP_DATA_TIME_MAX,
		};
	err = bt_conn_le_data_len_update(my_current_conn, &my_data_len);
	if (err)
	{
		LOG_ERR("data_len_update failed (err %d)", err);
	}
}

static void update_phy(struct bt_conn *conn)
{
	int err;
	const struct bt_conn_le_phy_param preferred_phy = {
		.options = BT_CONN_LE_PHY_OPT_NONE,
		.pref_rx_phy = BT_GAP_LE_PHY_2M,
		.pref_tx_phy = BT_GAP_LE_PHY_2M,
	};
	err = bt_conn_le_phy_update(conn, &preferred_phy);
	if (err)
	{
		LOG_ERR("bt_conn_le_phy_update() returned %d", err);
	}
}
void set_ble_connected_status(bool connected)
{
	ble_connected = connected;
}
/**
 * @retval 获取当前 BLE 连接状态
 * @return false 未连接，true 已连接
 */
bool get_ble_connected_status(void)
{
	return ble_connected;
}
static void my_connected(struct bt_conn *conn, uint8_t err)
{
	char addr[BT_ADDR_LE_STR_LEN];
	if (err)
	{
		LOG_ERR("Connection failed, err 0x%02x %s", err, bt_hci_err_to_str(err));
		return;
	}
	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));
	LOG_INF("Connected: %s", addr);
	my_current_conn = bt_conn_ref(conn);
	set_ble_connected_status(true);
	/* Update the connection parameters */
	struct bt_conn_info info;
	err = bt_conn_get_info(conn, &info);
	if (err)
	{
		LOG_ERR("bt_conn_get_info() returned %d", err);
		return;
	}
	double connection_interval = info.le.interval * 1.25; // in ms
	uint16_t supervision_timeout = info.le.timeout * 10;  // in ms
	LOG_INF("my_connected -> Connection parameters: interval %.2f ms, latency %d intervals, timeout %d ms",
			connection_interval, info.le.latency, supervision_timeout);

	/* Update the PHY mode */
	// update_phy(my_current_conn);
	/* Update the data length and MTU */
	// update_data_length(my_current_conn);
	// update_mtu(my_current_conn);
}
static void my_disconnected(struct bt_conn *conn, uint8_t reason)
{
	char addr[BT_ADDR_LE_STR_LEN];
	bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));
	LOG_INF("Disconnected: %s, reason 0x%02x %s", addr, reason, bt_hci_err_to_str(reason));
	set_ble_connected_status(false);
	if (auth_conn)
	{
		bt_conn_unref(auth_conn);
		auth_conn = NULL;
	}
	if (my_current_conn)
	{
		bt_conn_unref(my_current_conn);
		my_current_conn = NULL;
	}
}
void on_le_param_updated(struct bt_conn *conn,
						 uint16_t interval,
						 uint16_t latency,
						 uint16_t timeout)
{
	double connection_interval = interval * 1.25; // in ms
	uint16_t supervision_timeout = timeout * 10;  // in ms
	LOG_INF("on_le_param_updated -> Connection parameters updated: interval %.2f ms, latency %d intervals, timeout %d ms",
			connection_interval, latency, supervision_timeout);
}
void on_le_phy_updated(struct bt_conn *conn, struct bt_conn_le_phy_info *param)
{
	if (param->tx_phy == BT_CONN_LE_TX_POWER_PHY_1M)
	{
		LOG_INF("PHY updated. New PHY: 1M");
	}
	else if (param->tx_phy == BT_CONN_LE_TX_POWER_PHY_2M)
	{
		LOG_INF("PHY updated. New PHY: 2M");
	}
	else if (param->tx_phy == BT_CONN_LE_TX_POWER_PHY_CODED_S8)
	{
		LOG_INF("PHY updated. New PHY: Long Range");
	}
}
void on_le_data_len_updated(struct bt_conn *conn, struct bt_conn_le_data_len_info *info)
{
	uint16_t tx_len = info->tx_max_len;
	uint16_t tx_time = info->tx_max_time;
	uint16_t rx_len = info->rx_max_len;
	uint16_t rx_time = info->rx_max_time;
	LOG_INF("Data length updated. Length %d/%d bytes, time %d/%d us", tx_len, rx_len, tx_time, rx_time);
}

BT_CONN_CB_DEFINE(conn_callbacks) = {
	.connected = my_connected,
	.disconnected = my_disconnected,
	.recycled = recycled_cb,
	.le_param_updated = on_le_param_updated,
	.le_phy_updated = on_le_phy_updated,
	.le_data_len_updated = on_le_data_len_updated,
#ifdef CONFIG_BT_NUS_SECURITY_ENABLED
	.security_changed = security_changed,
#endif
};
/**
 * @brief 获取当前MTU
 */
uint16_t get_ble_payload_mtu(void)
{
	return payload_mtu;
}
void mtu_updated(struct bt_conn *conn, uint16_t tx, uint16_t rx)
{
	payload_mtu = bt_gatt_get_mtu(conn) - 3; // 3 bytes used for Attribute headers.
	LOG_INF("Updated MTU: TX: %d RX: %d bytes", tx, rx);
	LOG_INF("Updated MTU: %d; Payload=[%d] ", payload_mtu + 3, payload_mtu);
}
static struct bt_gatt_cb gatt_callbacks = {
	.att_mtu_updated = mtu_updated};
/**
 * @brief 蓝牙广播间隔设置
 * @param time_ms
 */
void ble_interval_set(uint16_t min, uint16_t max)
{
	g_adv_param.options = BT_LE_ADV_OPT_CONN | BT_LE_ADV_OPT_USE_IDENTITY;
	g_adv_param.interval_min = BT_GAP_PER_ADV_MS_TO_INTERVAL(min);
	g_adv_param.interval_max = BT_GAP_PER_ADV_MS_TO_INTERVAL(max);
}

static struct custom_nus_cb my_nus_cb = {
	.received = bt_receive_cb,
	// .sent = bt_sent_cb,
	// .send_enabled = bt_notify_cb,
};

static void app_info(void)
{
	BSP_LOGI(TAG,
			 "\n\n-------------------------------------------\n|\n"
			 "|	[%s] \n|\n"
			 "|	Firm Version: %s\n"
			 "|	Build Time: %s %s\n"
			 "|	IDF Version: %s\n|\n"
			 "-------------------------------------------\n",
			 XYZN_PROJECT_NAME,
			 XYZN_FIRMWARE_VERSION,
			 XYZN_COMPILE_DATE, XYZN_COMPILE_TIME,
			 XYZN_SDK_VERSION);
}

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
// 初始化高频时钟128Mhz运行模式
SYS_INIT(hfclock_config_and_start, POST_KERNEL, 0);

int main(void)
{
	int err = 0;
	app_info();
	g_adv_param = *(BT_LE_ADV_CONN_FAST_2);
	ble_interval_set(100, 100); // 设置广播间隔
	if (IS_ENABLED(CONFIG_BT_NUS_SECURITY_ENABLED))
	{
		err = bt_conn_auth_cb_register(&conn_auth_callbacks);
		if (err)
		{
			LOG_ERR("Failed to register authorization callbacks. (err: %d)", err);
			return 0;
		}

		err = bt_conn_auth_info_cb_register(&conn_auth_info_callbacks);
		if (err)
		{
			LOG_ERR("Failed to register authorization info callbacks. (err: %d)", err);
			return 0;
		}
	}

	err = bt_enable(NULL);
	if (err)
	{
		LOG_INF("Bluetooth not enabled (err: %d)", err);
	}
	LOG_INF("Bluetooth initialized 001");
	ble_init_sem_give();
	if (IS_ENABLED(CONFIG_SETTINGS))
	{
		settings_load();
	}
	err = custom_nus_init(&my_nus_cb);
	if (err)
	{
		LOG_ERR("Failed to bt_nus_init service (err: %d)", err);
		return 0;
	}
	k_work_init(&adv_work, adv_work_handler);
	advertising_start();

	bt_gatt_cb_register(&gatt_callbacks);

	xyzn_os_delay_ms(1000);
	image_cache_init();
	bsp_board_mcu_init();

	lvgl_dispaly_thread();
	ble_protocol_receive_thread();
	ble_protocol_send_thread();
	protocol_ble_process_thread();

	task_process_thread();
	task_interrupt_thread();
	task_lc3_codec_thread();

	uint8_t mac[BT_ADDR_LE_STR_LEN] = {0};
	get_ble_mac_addr(mac, sizeof(mac));
	ble_name_update_data(mac);
	int count = 0;
	static int clk_128_flag = 0;

	for (;;)
	{
		BSP_LOGI(TAG, "Starting main thread %d", count++);
		primary_feed_worker();
		xyzn_os_delay_ms(10000);
		if (clk_128_flag == 0)
		{
			uint32_t clk = NRF_CLOCK->HFCLKCTRL;
			if ((clk & 0x1) == 0)
			{
				clk_128_flag = 1;
				LOG_INF("HFCLKCTRL: 128 MHz");
			}
			else
			{
				LOG_INF("HFCLKCTRL: 64 MHz");
			}
		}
	}
}
