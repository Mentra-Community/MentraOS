/***
 * @Author       : Cole
 * @Date         : 2025-07-31 11:52:17
 * @LastEditTime : 2025-07-31 17:03:16
 * @FilePath     : bsp_key.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef __BSP_KEY_H__
#define __BSP_KEY_H__

extern struct gpio_dt_spec gpio_key1;

int bsp_key_init(void);

void gpio_key1_int_isr_enable(void);

bool gpio_key1_read(void);

#endif /* __BSP_KEY_H__ */
