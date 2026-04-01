/*** 
 * @Author       : Cole
 * @Date         : 2026-03-03 17:06:05
 * @LastEditTime : 2026-03-04 17:37:27
 * @FilePath     : vad_interrupt_handler.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2026 
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _VAD_INTERRUPT_HANDLER_H_
#define _VAD_INTERRUPT_HANDLER_H_

#include <stdbool.h>

int vad_interrupt_handler_init(void);
int vad_interrupt_handler_send_event(void);
int vad_interrupt_handler_re_enable(void);
bool vad_interrupt_handler_is_i2s_active(void);
void vad_interrupt_handler_set_enabled(bool enabled);
bool vad_interrupt_handler_is_enabled(void);
int vad_voice_detect_set_low(void);
int vad_voice_detect_set_high(void);

#endif /* _VAD_INTERRUPT_HANDLER_H_ */
