/*** 
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-07-31 17:16:06
 * @FilePath     : main.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef __MAIN_H_
#define __MAIN_H_

#include <stdint.h>

int ble_init_sem_take(void);

void advertising_start(void);

bool get_ble_connected_status(void);

uint16_t get_ble_payload_mtu(void);

void ble_interval_set(uint16_t min, uint16_t max);

void ble_name_update_data(const char *name);
#endif // __MAIN_H_