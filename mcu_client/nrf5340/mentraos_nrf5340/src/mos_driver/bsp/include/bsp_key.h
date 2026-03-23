/***
 * @Author       : XK
 * @Date         : 2025-07-15 10:03:47
 * @LastEditTime : 2025-07-15 10:04:14
 * @FilePath     : bsp_key.h
 * @Description  :
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */
#ifndef __BSP_KEY_H__
#define __BSP_KEY_H__



#include "bsp_log.h"


extern struct gpio_dt_spec gpio_key1;

int bsp_key_init(void);

void gpio_key1_int_isr_enable(void);

bool gpio_key1_read(void);
#endif /* __BSP_KEY_H__ */

