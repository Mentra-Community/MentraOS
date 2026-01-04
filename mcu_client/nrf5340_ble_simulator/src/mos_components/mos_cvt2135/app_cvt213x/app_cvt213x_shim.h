/*** 
 * @Author       : Cole
 * @Date         : 2025-12-31 15:08:04
 * @LastEditTime : 2026-01-04 10:40:29
 * @FilePath     : app_cvt213x_shim.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2026 
 * @ SPDX-License-Identifier: Apache-2.0
 */
#ifndef APP_CVT213X_SHIM_H
#define APP_CVT213X_SHIM_H

#include <stdint.h>


/* Hardware I2C helpers (Zephyr-backed). Use these in porting layer. */
int cvt213x_hw_i2c_write(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size);
int cvt213x_hw_i2c_read(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size);

/* Backwards-compatible aliases (call through to hw versions) */
int cvt213x_sw_i2c_write(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size);
int cvt213x_sw_i2c_read(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size);

/* HAL helpers (Zephyr-backed) */
int     cvt213x_hal_i2c_init(void);
int     cvt213x_hal_irq_init(void);
uint8_t cvt213x_hal_irq_get_level(int chipIndex);

/* Flash emulation */
void cm_write(const void* buf, int page, int len);
void cm_sync(void);
void cm_read(void* buf, int page, int len);

/* Bluetooth SPP */
int bt_spp_tx(const void* packet, int len);

/* Message queue */
void msg_enqueue(int e);

#endif /* APP_CVT213X_SHIM_H */
