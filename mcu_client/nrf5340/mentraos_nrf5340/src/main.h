/*** 
 * @Author       : XK
 * @Date         : 2025-06-18 17:06:12
 * @LastEditTime : 2025-06-18 17:06:15
 * @FilePath     : main.h
 * @Description  : 
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved. 
 */


 #ifndef __MAIN_H   
 #define __MAIN_H
#include <stdint.h>

int ble_init_sem_take(void);

void advertising_start(void);

bool get_ble_connected_status(void);

uint16_t get_ble_payload_mtu(void);

void ble_interval_set(uint16_t min, uint16_t max);

void ble_name_update_data(const char *name);
#endif // __MAIN_H