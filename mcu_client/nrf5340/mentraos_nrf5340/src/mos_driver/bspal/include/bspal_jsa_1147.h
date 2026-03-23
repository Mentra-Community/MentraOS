/*** 
 * @Author       : XK
 * @Date         : 2025-07-14 16:16:16
 * @LastEditTime : 2025-07-14 16:16:25
 * @FilePath     : bspal_jsa_1147.h
 * @Description  : 
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved. 
 */

 #ifndef _BSPAL_JSA_1147_H_
 #define _BSPAL_JSA_1147_H_

#include "bsp_log.h"

int bspal_jsa_1147_init(void);

int read_jsa_1147_int_flag(void);

int write_jsa_1147_int_flag(uint8_t flag);

void jsa_1147_test(void);



#endif // _BSPAL_JSA_1147_H_