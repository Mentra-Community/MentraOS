/***
 * @Author       : Cole
 * @Date         : 2025-07-31 10:50:32
 * @LastEditTime : 2025-07-31 16:38:32
 * @FilePath     : mos_ble_service.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _MOS_BLE_SERVICE_H_
#define _MOS_BLE_SERVICE_H_

#include <zephyr/types.h>

#define BT_UUID_MY_SERVICE_VAL \
    BT_UUID_128_ENCODE(0x00004860, 0x0000, 0x1000, 0x8000, 0x00805f9b34fb)

#define BT_UUID_MY_SERVICE_RX_VAL \
    BT_UUID_128_ENCODE(0x000071FF, 0x0000, 0x1000, 0x8000, 0x00805f9b34fb)

#define BT_UUID_MY_SERVICE_TX_VAL \
    BT_UUID_128_ENCODE(0x000070FF, 0x0000, 0x1000, 0x8000, 0x00805f9b34fb)

#define BT_UUID_CUSTOM_NUS_SERVICE BT_UUID_DECLARE_128(BT_UUID_MY_SERVICE_VAL)
#define BT_UUID_CUSTOM_NUS_RX BT_UUID_DECLARE_128(BT_UUID_MY_SERVICE_RX_VAL)
#define BT_UUID_CUSTOM_NUS_TX BT_UUID_DECLARE_128(BT_UUID_MY_SERVICE_TX_VAL)

enum custom_nus_send_status
{
    /** Send notification enabled. */
    CUSTOM_SEND_STATUS_ENABLED,
    /** Send notification disabled. */
    CUSTOM_NUS_SEND_STATUS_DISABLED,
};
/* Callback type definitions */
typedef void (*custom_nus_received_cb_t)(struct bt_conn *conn, const uint8_t *data, uint16_t len);
typedef void (*custom_nus_sent_cb_t)(struct bt_conn *conn);
typedef void (*custom_nus_send_enabled_cb_t)(enum custom_nus_send_status enabled);

/* Callback registration structure */
struct custom_nus_cb
{
    custom_nus_received_cb_t received;
    custom_nus_sent_cb_t sent;
    custom_nus_send_enabled_cb_t send_enabled;
};

int custom_nus_init(const struct custom_nus_cb *callbacks);

int custom_nus_send(struct bt_conn *conn, const uint8_t *data, uint16_t len);

#endif // _MOS_BLE_SERVICE_H_