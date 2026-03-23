/***
 * @Author       : Cole
 * @Date         : 2025-07-31 11:56:20
 * @LastEditTime : 2025-07-31 17:10:30
 * @FilePath     : bspal_jsa_1147.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _BSPAL_JSA_1147_H_
#define _BSPAL_JSA_1147_H_
#include <stdint.h>

int bspal_jsa_1147_init(void);

int read_jsa_1147_int_flag(void);

int write_jsa_1147_int_flag(uint8_t flag);

void jsa_1147_test(void);

#endif  // _BSPAL_JSA_1147_H_