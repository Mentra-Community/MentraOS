/***
 * @Author       : Cole
 * @Date         : 2025-12-17 17:51:52
 * @LastEditTime : 2026-01-30 14:10:25
 * @FilePath     : mos_ble_service.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2026
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef MOS_BLE_SERVICE_H_
#define MOS_BLE_SERVICE_H_

#include <zephyr/bluetooth/conn.h>
#include <zephyr/types.h>


/** @brief Service UUID (Mentra / Custom NUS). */
#define BT_UUID_MY_SERVICE_VAL BT_UUID_128_ENCODE(0x00004860, 0x0000, 0x1000, 0x8000, 0x00805f9b34fb)

/** @brief RX Characteristic UUID (Phone -> Glasses, write). */
#define BT_UUID_MY_SERVICE_RX_VAL BT_UUID_128_ENCODE(0x000071FF, 0x0000, 0x1000, 0x8000, 0x00805f9b34fb)

/** @brief TX Characteristic UUID (Glasses -> Phone, notify). */
#define BT_UUID_MY_SERVICE_TX_VAL BT_UUID_128_ENCODE(0x000070FF, 0x0000, 0x1000, 0x8000, 0x00805f9b34fb)

#define BT_UUID_CUSTOM_NUS_SERVICE BT_UUID_DECLARE_128(BT_UUID_MY_SERVICE_VAL)
#define BT_UUID_CUSTOM_NUS_RX      BT_UUID_DECLARE_128(BT_UUID_MY_SERVICE_RX_VAL)
#define BT_UUID_CUSTOM_NUS_TX      BT_UUID_DECLARE_128(BT_UUID_MY_SERVICE_TX_VAL)

/** @brief Alias for advertising (same value as BT_UUID_MY_SERVICE_VAL). */
#define BT_UUID_MENTRA_VAL BT_UUID_MY_SERVICE_VAL

/** @brief Notification subscription status. */
enum custom_nus_send_status
{
	/** Notifications enabled. */
	CUSTOM_SEND_STATUS_ENABLED,
	/** Notifications disabled. */
	CUSTOM_NUS_SEND_STATUS_DISABLED,
};

/** @brief Callback when data is received on RX characteristic. */
typedef void (*custom_nus_received_cb_t)(struct bt_conn* conn, const uint8_t* data, uint16_t len);

/** @brief Callback when a notification has been sent. */
typedef void (*custom_nus_sent_cb_t)(struct bt_conn* conn);

/** @brief Callback when CCC is changed (notify enabled/disabled). */
typedef void (*custom_nus_send_enabled_cb_t)(enum custom_nus_send_status enabled);

/** @brief Callback set; copied in custom_nus_init(), may be freed after init. */
struct custom_nus_cb
{
	custom_nus_received_cb_t     received;
	custom_nus_sent_cb_t         sent;
	custom_nus_send_enabled_cb_t send_enabled;
};

/**
 * @brief Initialize the BLE service and register callbacks.
 *
 * @param callbacks Callback structure (copied internally; may be freed after return).
 * @return 0 on success.
 */
int custom_nus_init(const struct custom_nus_cb* callbacks);

/**
 * @brief Send data via TX characteristic (notify).
 *
 * @param conn Connection (NULL to notify all subscribed clients).
 * @param data Data to send.
 * @param len Length of data.
 * @return 0 on success, -EINVAL if conn is set but not subscribed.
 */
int custom_nus_send(struct bt_conn* conn, const uint8_t* data, uint16_t len);


#endif /* MOS_BLE_SERVICE_H_ */
