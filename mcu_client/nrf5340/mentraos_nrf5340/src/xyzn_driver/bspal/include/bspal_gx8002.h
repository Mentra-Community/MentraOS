/***
 * @Author       : XK
 * @Date         : 2025-07-11 14:52:10
 * @LastEditTime : 2025-07-11 14:52:14
 * @FilePath     : bspal_gx8002.h
 * @Description  :
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
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