/*** 
 * @Author       : Cole
 * @Date         : 2025-12-26 17:28:28
 * @LastEditTime : 2025-12-26 17:35:24
 * @FilePath     : stp513n.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef _STP513N_H_
#define _STP513N_H_

#include <stdbool.h>
#include <stdint.h>
#include <zephyr/kernel.h>

/**
 * @brief SPT513N I2C address
 */
#define STP513N_I2C_ADDR 0x60

/**
 * @brief Initialize SPT513N driver
 * @return 0 on success, negative error code on failure
 */
int stp513n_init(void);

/**
 * @brief Check if SPT513N is initialized
 * @return true if initialized, false otherwise
 */
bool stp513n_is_initialized(void);

/**
 * @brief Reset SPT513N chip via reset GPIO and connect within 100ms
 * @note Reset sequence: pull low 20ms, then pull high 10ms
 * @note Must call stp513n_connect() within 100ms after reset to enter test mode
 * @return 0 on success, negative error code on failure
 */
int stp513n_reset_and_connect(void);

/**
 * @brief Soft reset SPT513N via I2C command
 * @note Only works in upgrade window or test mode
 * @return 0 on success, negative error code on failure
 */
int stp513n_soft_reset(void);

/**
 * @brief Connect to SPT513N in test mode
 * @note Must be called within 100ms after reset to enter test mode
 * @return 0 on success, 1 on failure
 */
uint8_t stp513n_connect(void);

/**
 * @brief Read a register from STP513N
 * @param addr Register address
 * @return Register value, or 0xFF on error
 */
uint8_t stp513n_read_reg(uint8_t addr);

/**
 * @brief Write a register to STP513N
 * @param addr Register address
 * @param value Register value
 * @return 0 on success, negative error code on failure
 */
int stp513n_write_reg(uint8_t addr, uint8_t value);

/**
 * @brief Read a byte from EEPROM
 * @param addr EEPROM address (0-63)
 * @return EEPROM byte value, or 0xFF on error
 */
uint8_t stp513n_read_eeprom(uint8_t addr);

/**
 * @brief Write a byte to EEPROM
 * @param addr EEPROM address (0-63)
 * @param data Data byte to write
 * @return 0 on success, negative error code on failure
 */
int stp513n_write_eeprom(uint8_t addr, uint8_t data);

/**
 * @brief Get EEPROM write status
 * @return Non-zero if EEPROM is busy, 0 if ready
 */
uint8_t stp513n_get_eeprom_status(void);

/**
 * @brief Update SPT513N configuration
 * @param config_buffer Configuration data (64 bytes)
 * @param config_len Configuration length (should be 64)
 * @return 0 on success, negative error code on failure
 */
int stp513n_update_config(const uint8_t* config_buffer, uint8_t config_len);

/**
 * @brief Verify configuration
 * @param config_buffer Expected configuration data
 * @param read_buffer Read configuration data
 * @param length Length to verify
 * @return 0 if match, 1 if mismatch
 */
uint8_t stp513n_config_verify(const uint8_t* config_buffer, const uint8_t* read_buffer, uint8_t length);

/**
 * @brief Read current configuration from EEPROM
 * @param buffer Buffer to store configuration (must be at least 64 bytes)
 * @param length Length to read (should be 64)
 * @return 0 on success, negative error code on failure
 */
int stp513n_read_config(uint8_t* buffer, uint8_t length);

/**
 * @brief Scan I2C bus for devices
 * @param found_addr Pointer to store found address (optional, can be NULL)
 * @return 0 if device found at expected address, negative error code on failure
 */
int stp513n_scan_i2c(uint8_t *found_addr);

#endif /* _STP513N_H_ */


