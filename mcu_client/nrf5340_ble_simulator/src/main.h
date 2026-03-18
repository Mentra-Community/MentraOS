#ifndef MAIN_H
#define MAIN_H

#include <stdbool.h>
#include <zephyr/types.h>

/**
 * @brief Get the current BLE device name (includes MAC address suffix)
 * @return Pointer to the device name string (e.g., "Display-A1B2C3")
 */
const char *get_ble_device_name(void);

/**
 * @brief Get BLE connection status
 * @return true if a BLE client is connected, false otherwise
 */
bool get_ble_connected_status(void);

/**
 * @brief Send data over BLE to connected client(s)
 *
 * Handles MTU-based chunking and retries internally.
 * Returns immediately if no BLE client is connected.
 *
 * @param data Pointer to the data to send
 * @param len  Length of the data to send
 * @return 0 on success, -1 on failure
 */
int ble_send_data(const uint8_t *data, uint16_t len);

/**
 * @brief Force-disconnect the current BLE connection
 *
 * Terminates the active BLE link. Triggers the normal disconnected() callback
 * which shows the disconnect screen and recycled_cb() which restarts advertising.
 * Safe to call when already disconnected (no-op if current_conn is NULL).
 */
void ble_force_disconnect(void);

#endif /* MAIN_H */