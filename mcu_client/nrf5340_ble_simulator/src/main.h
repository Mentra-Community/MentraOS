#ifndef MAIN_H
#define MAIN_H

#include <stdbool.h>

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

#endif /* MAIN_H */