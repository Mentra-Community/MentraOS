/*** 
 * @Author       : Cole
 * @Date         : 2025-12-04 19:24:44
 * @LastEditTime : 2025-12-05 09:40:19
 * @FilePath     : vad_interrupt_handler.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef _VAD_INTERRUPT_HANDLER_H_
#define _VAD_INTERRUPT_HANDLER_H_

#include <stdbool.h>
#include <stdint.h>

#include "interrupt_handler.h"

// VAD interrupt event type (use enum from interrupt_handler.h)
#define VAD_INT_EVENT_VAD_FALLING_EDGE INTERRUPT_TYPE_VAD_FALLING_EDGE
#define VAD_INT_EVENT_VAD_TIMEOUT     INTERRUPT_TYPE_VAD_TIMEOUT

/**
 * @brief Initialize VAD interrupt handler
 * 
 * Registers VAD interrupt callbacks with the interrupt_handler framework.
 * GPIO and interrupt callback should be initialized in bsp_gx8002.c
 * 
 * @return 0 on success, negative error code on failure
 */
int vad_interrupt_handler_init(void);

/**
 * @brief Send VAD interrupt event to processing queue
 * 
 * Called from ISR context in bsp_gx8002.c
 * 
 * @return 0 on success, negative error code on failure
 */
int vad_interrupt_handler_send_event(void);

/**
 * @brief Re-enable VAD interrupt after processing
 * 
 * Called from interrupt processing thread after handling the event
 * 
 * @return 0 on success, negative error code on failure
 */
int vad_interrupt_handler_re_enable(void);

/**
 * @brief Check if I2S reception is currently active
 * 
 * @return true if I2S is receiving data, false otherwise
 */
bool vad_interrupt_handler_is_i2s_active(void);

/**
 * @brief Get current timeout value in milliseconds
 * 
 * @return Current timeout value in ms, 0 if not active
 */
int32_t vad_interrupt_handler_get_timeout_ms(void);

#endif /* _VAD_INTERRUPT_HANDLER_H_ */

