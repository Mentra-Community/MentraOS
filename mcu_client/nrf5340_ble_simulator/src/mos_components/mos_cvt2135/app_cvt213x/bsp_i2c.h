/* bsp_i2c.h
 * Minimal shim for BSP I2C functions expected by legacy CVT213x porting code.
 * Keeps changes minimal: provides a no-op I2C init and a delay_ms() mapping
 * to Zephyr's k_msleep().
 */

#ifndef _BSP_I2C_H_
#define _BSP_I2C_H_

#include <stdint.h>
#include <zephyr/kernel.h>
#include <zephyr/types.h>

#ifdef __cplusplus
extern "C"
{
#endif

static inline void bsp_i2c_init(void)
{
    /* Intentionally empty: Zephyr I2C devices are configured through devicetree
        * and drivers. If specific board initialization is needed, replace this
        * implementation with platform-specific code. */
}

static inline void delay_ms(uint32_t ms)
{
    k_msleep(ms);
}

#ifdef __cplusplus
}
#endif

#endif /* _BSP_I2C_H_ */
