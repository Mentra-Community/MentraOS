/*
 * @Author       : Cole
 * @Date         : 2026-01-30 09:30:43
 * @LastEditTime : 2026-01-30 14:12:31
 * @FilePath     : mos_ble_service.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */


#include <string.h>

#include <zephyr/types.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/logging/log.h>

#include "mos_ble_service.h"

LOG_MODULE_REGISTER(mos_ble_service, LOG_LEVEL_INF);

/** TX characteristic is the 3rd attribute in the service (index 2). */
#define MOS_BLE_TX_CHAR_ATTR_INDEX 2

static struct custom_nus_cb nus_cb;

static void nus_ccc_cfg_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
	ARG_UNUSED(attr);

	if (nus_cb.send_enabled) 
	{
		enum custom_nus_send_status st = (value == BT_GATT_CCC_NOTIFY)
						 ? CUSTOM_SEND_STATUS_ENABLED
						 : CUSTOM_NUS_SEND_STATUS_DISABLED;
		LOG_INF("NUS notify %s", st == CUSTOM_SEND_STATUS_ENABLED ? "enabled" : "disabled");
		nus_cb.send_enabled(st);
	}
}

static ssize_t on_receive(struct bt_conn *conn, const struct bt_gatt_attr *attr,
			  const void *buf, uint16_t len, uint16_t offset, uint8_t flags)
{
	ARG_UNUSED(attr);
	ARG_UNUSED(offset);
	ARG_UNUSED(flags);

	if (nus_cb.received) 
	{
		nus_cb.received(conn, buf, len);
	}
	return len;
}

static void on_sent(struct bt_conn *conn, void *user_data)
{
	ARG_UNUSED(user_data);

	if (nus_cb.sent) 
	{
		nus_cb.sent(conn);
	}
}

BT_GATT_SERVICE_DEFINE(custom_nus_svc,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_CUSTOM_NUS_SERVICE),
	BT_GATT_CHARACTERISTIC(BT_UUID_CUSTOM_NUS_TX,
			       BT_GATT_CHRC_NOTIFY | BT_GATT_CHRC_READ,
#ifdef CONFIG_BT_NUS_AUTHEN
			       BT_GATT_PERM_READ_AUTHEN,
#else
			       BT_GATT_PERM_READ,
#endif
			       NULL, NULL, NULL),
	BT_GATT_CCC(nus_ccc_cfg_changed,
#ifdef CONFIG_BT_NUS_AUTHEN
		    BT_GATT_PERM_READ_AUTHEN | BT_GATT_PERM_WRITE_AUTHEN),
#else
		    BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
#endif
	BT_GATT_CHARACTERISTIC(BT_UUID_CUSTOM_NUS_RX,
			       BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
#ifdef CONFIG_BT_NUS_AUTHEN
			       BT_GATT_PERM_READ_AUTHEN | BT_GATT_PERM_WRITE_AUTHEN,
#else
			       BT_GATT_PERM_READ | BT_GATT_PERM_WRITE,
#endif
			       NULL, on_receive, NULL),
);

int custom_nus_init(const struct custom_nus_cb *callbacks)
{
	if (callbacks) 
	{
		nus_cb.received     = callbacks->received;
		nus_cb.sent         = callbacks->sent;
		nus_cb.send_enabled = callbacks->send_enabled;
	} 
	else 
	{
		memset(&nus_cb, 0, sizeof(nus_cb));
	}
	return 0;
}

int custom_nus_send(struct bt_conn *conn, const uint8_t *data, uint16_t len)
{
	const struct bt_gatt_attr *attr = &custom_nus_svc.attrs[MOS_BLE_TX_CHAR_ATTR_INDEX];
	struct bt_gatt_notify_params params = {
		.attr = attr,
		.data = data,
		.len  = len,
		.func = on_sent,
	};

	if (conn == NULL) 
	{
		return bt_gatt_notify_cb(NULL, &params);
	}
	if (bt_gatt_is_subscribed(conn, attr, BT_GATT_CCC_NOTIFY)) 
	{
		return bt_gatt_notify_cb(conn, &params);
	}
	return -EINVAL;
}
