/*** 
 * @Author       : Cole
 * @Date         : 2025-07-31 11:56:20
 * @LastEditTime : 2025-07-31 17:08:47
 * @FilePath     : bspal_gx8002.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _BSPAL_GX8002_H_
#define _BSPAL_GX8002_H_


int gx8002_read_voice_event(void);

int gx8002_open_dmic(void);

int gx8002_reset(void);

int gx8002_get_mic_state(void);

int gx8002_open_dmic(void);

int gx8002_close_dmic(void);
#endif // !_BSPAL_GX8002_H_