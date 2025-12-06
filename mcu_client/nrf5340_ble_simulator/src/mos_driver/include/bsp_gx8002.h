/*** 
 * @Author       : Cole
 * @Date         : 2025-12-03
 * @LastEditTime : 2025-12-03
 * @FilePath     : bsp_gx8002.h
 * @Description  : GX8002 BSP driver interface
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */
#ifndef _BSP_GX8002_H_
#define _BSP_GX8002_H_

#include <zephyr/kernel.h>
#include <stdint.h>

/**
 * @brief Initialize GX8002 driver
 * @return 0 on success, negative error code on failure
 */
int bsp_gx8002_init(void);

/**
 * @brief Reset GX8002 chip via power GPIO (power off 100ms then power on)
 */
void bsp_gx8002_reset(void);

/**
 * @brief Get GX8002 firmware version
 * @param version Pointer to version array (4 bytes)
 * @return 1 on success, 0 on failure
 */
uint8_t bsp_gx8002_getversion(uint8_t *version);

/**
 * @brief Handshake with GX8002
 * @return 1 on success, 0 on failure
 */
uint8_t bsp_gx8002_handshake(void);

/**
 * @brief Start GX8002 I2S audio output
 * @return 1 on success, 0 on failure
 * 
 * This function configures GX8002 to start I2S master mode output.
 * After calling this, GX8002 will send I2S clock signals (SCK, LRCK) and audio data.
 */
uint8_t bsp_gx8002_start_i2s(void);

/**
 * @brief Enable GX8002 I2S output
 * @return 1 on success, 0 on failure
 * 
 * Writes 0x71 to register 0xC4 at address 0x2F to enable I2S output
 */
uint8_t bsp_gx8002_enable_i2s(void);

/**
 * @brief Disable GX8002 I2S output
 * @return 1 on success, 0 on failure
 * 
 * Writes 0x72 to register 0xC4 at address 0x2F to disable I2S output
 */
uint8_t bsp_gx8002_disable_i2s(void);

/**
 * @brief Get GX8002 microphone (VAD) state
 * @param state Pointer to store the state (0=异常/异常, 1=正常/Normal)
 * @return 1 on success, 0 on failure
 * 
 * Writes 0x70 to register 0xC4 at address 0x2F, then reads register 0xA0
 * State code: 0=异常, 1=正常
 */
uint8_t bsp_gx8002_get_mic_state(uint8_t *state);

/**
 * @brief Check if GX8002 I2S is enabled
 * @return 1 if I2S is enabled (via enable_i2s command), 0 if disabled
 * 
 * This function returns the state of I2S enable flag, which is set when
 * bsp_gx8002_enable_i2s() is called successfully and cleared when
 * bsp_gx8002_disable_i2s() is called.
 */
uint8_t bsp_gx8002_is_i2s_enabled(void);

// Internal I2C functions for OTA update (used by gx8002_update.c)
/**
 * @brief Write data to GX8002 via I2C
 * @param slave_address I2C slave address (GX_DATA_ADDR or GX_CMD_ADDR)
 * @param buf Data buffer to write
 * @param buf_len Buffer length
 * @return 1 on success, 0 on failure
 */
uint8_t bsp_gx8002_iic_write_data(uint8_t slave_address, uint8_t *buf, int buf_len);

/**
 * @brief Read data from GX8002 via I2C
 * @param slave_address I2C slave address
 * @param reg Register address to read
 * @param data Pointer to store read data
 * @return 1 on success, 0 on failure
 */
uint8_t bsp_gx8002_iic_read_data(uint8_t slave_address, uint8_t reg, uint8_t *data);

/**
 * @brief Wait for reply from GX8002 register
 * @param slave_address I2C slave address
 * @param reg Register address to poll
 * @param reply Expected reply value
 * @param timeout_ms Timeout in milliseconds
 * @return 1 on success, 0 on failure
 */
uint8_t bsp_gx8002_iic_wait_reply(uint8_t slave_address, uint8_t reg, uint8_t reply, int timeout_ms);

// I2C address definitions for OTA
// Note: GX_DATA_ADDR can be 0x35 or 0x36 depending on hardware configuration
#define BSP_GX_DATA_ADDR    0x36  // Original code uses 0x36
#define BSP_GX_CMD_ADDR     0x2F

/**
 * @brief Re-enable VAD interrupt after processing
 * 
 * Called from interrupt handler thread after handling the event
 * 
 * @return 0 on success, negative error code on failure
 */
int bsp_gx8002_vad_int_re_enable(void);

/**
 * @brief Disable VAD interrupt (used during firmware update to prevent I2C conflicts)
 * 
 * @return 0 on success, negative error code on failure
 */
int bsp_gx8002_vad_int_disable(void);

#endif /* _BSP_GX8002_H_ */

