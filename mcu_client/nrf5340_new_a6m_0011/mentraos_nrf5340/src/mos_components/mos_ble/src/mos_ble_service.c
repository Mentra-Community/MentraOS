/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-19 20:23:27
 * @FilePath     : mos_ble_service.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */



#include <zephyr/bluetooth/bluetooth.h>

#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/types.h>
#include "mos_ble_service.h"
#include <zephyr/logging/log.h>
#define LOG_MODULE_NAME BLE_SERVICE
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

static struct custom_nus_cb nus_cb;

/* ======================= CCCD Change ============================= */
static void nus_ccc_cfg_changed(const struct bt_gatt_attr *attr, uint16_t value)
{
    if (nus_cb.send_enabled)
    {
        bool enabled = (value == BT_GATT_CCC_NOTIFY ? CUSTOM_SEND_STATUS_ENABLED : CUSTOM_NUS_SEND_STATUS_DISABLED);
        LOG_INF("Custom NUS notify %s", enabled ? "enabled" : "disabled");
        nus_cb.send_enabled(enabled);
    }
}

/* ======================= RX Write Handler ======================== */
static ssize_t on_receive(struct bt_conn *conn, const struct bt_gatt_attr *attr, const void *buf, uint16_t len,
                          uint16_t offset, uint8_t flags)
{
    ARG_UNUSED(attr);
    ARG_UNUSED(offset);
    ARG_UNUSED(flags);
    // LOG_INF("Custom NUS RX data received: len=%d", len);
    if (nus_cb.received)
    {
        nus_cb.received(conn, buf, len);
    }
    return len;
}

/* ======================= TX Sent Callback ======================== */
static void on_sent(struct bt_conn *conn, void *user_data)
{
    ARG_UNUSED(user_data);
    // LOG_INF("Custom NUS TX sent to conn %p", (void *)conn);
    if (nus_cb.sent)
    {
        nus_cb.sent(conn);
    }
}

/* ======================= GATT Service ============================ */
BT_GATT_SERVICE_DEFINE(custom_nus_svc, BT_GATT_PRIMARY_SERVICE(BT_UUID_CUSTOM_NUS_SERVICE),
                       BT_GATT_CHARACTERISTIC(BT_UUID_CUSTOM_NUS_TX, BT_GATT_CHRC_NOTIFY | BT_GATT_CHRC_READ,
#ifdef CONFIG_BT_NUS_AUTHEN
                                              BT_GATT_PERM_READ_AUTHEN,
#else
                                              BT_GATT_PERM_READ,
#endif /* CONFIG_BT_NUS_AUTHEN */
                                              NULL, NULL, NULL),
                       BT_GATT_CCC(nus_ccc_cfg_changed,
#ifdef CONFIG_BT_NUS_AUTHEN
                                   BT_GATT_PERM_READ_AUTHEN | BT_GATT_PERM_WRITE_AUTHEN),
#else
                                   BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
#endif /* CONFIG_BT_NUS_AUTHEN */
                       BT_GATT_CHARACTERISTIC(BT_UUID_CUSTOM_NUS_RX,
                                              BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
//   BT_GATT_CHRC_WRITE | BT_GATT_CHRC_WRITE_WITHOUT_RESP,
#ifdef CONFIG_BT_NUS_AUTHEN
                                              BT_GATT_PERM_READ_AUTHEN | BT_GATT_PERM_WRITE_AUTHEN,
#else
                                              BT_GATT_PERM_READ | BT_GATT_PERM_WRITE,
#endif /* CONFIG_BT_NUS_AUTHEN */
                                              NULL, on_receive, NULL), );
/* ======================= Public API ============================== */
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
    struct bt_gatt_notify_params params = {0};
    const struct bt_gatt_attr   *attr   = &custom_nus_svc.attrs[2];  // TX characteristic index

    params.attr = attr;
    params.data = data;
    params.len  = len;
    params.func = on_sent;

    if (!conn)
    {
        return bt_gatt_notify_cb(NULL, &params);  // broadcast to all
    }
    else if (bt_gatt_is_subscribed(conn, attr, BT_GATT_CCC_NOTIFY))
    {
        return bt_gatt_notify_cb(conn, &params);
    }
    else
    {
        return -EINVAL;
    }
}