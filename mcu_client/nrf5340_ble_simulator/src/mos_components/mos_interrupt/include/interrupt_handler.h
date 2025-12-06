/*** 
 * @Author       : Cole
 * @Date         : 2025-12-04 19:32:27
 * @LastEditTime : 2025-12-05 10:31:13
 * @FilePath     : interrupt_handler.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef _INTERRUPT_HANDLER_H_
#define _INTERRUPT_HANDLER_H_

#include <stdbool.h>
#include <stdint.h>

// Interrupt type enumeration with names
typedef enum
{
    INTERRUPT_TYPE_UNKNOWN = 0,        // Unknown/Invalid interrupt
    INTERRUPT_TYPE_VAD_FALLING_EDGE,   // VAD interrupt falling edge (P0.12)
    INTERRUPT_TYPE_VAD_TIMEOUT,        // VAD timeout event (from timer callback)

    INTERRUPT_TYPE_MAX_COUNT            // Maximum interrupt type count (must be last)
} interrupt_type_enum_t;

typedef interrupt_type_enum_t interrupt_event_type_t;

// Interrupt event structure
typedef struct
{
    interrupt_event_type_t event;  // Event type identifier
    uint64_t               tick;   // Timestamp when interrupt occurred
    void*                  data;   // Optional event-specific data
} interrupt_event_t;

// Interrupt event callback function type
// Called from interrupt processing thread context
typedef void (*interrupt_event_callback_t)(interrupt_event_t* event);

// Interrupt callback registry entry structure
typedef struct
{
    interrupt_event_callback_t callback;  // Callback function pointer
    const char*                name;      // Interrupt name (e.g., "VAD_FALLING_EDGE")
    const char*                description; // Interrupt description
    bool                       registered; // Registration status
} interrupt_callback_entry_t;

/**
 * @brief Initialize interrupt handler framework
 * 
 * Creates the unified interrupt processing thread and message queue.
 * This should be called once during system initialization.
 * 
 * @return 0 on success, negative error code on failure
 */
int interrupt_handler_init(void);

/**
 * @brief Register an interrupt event callback
 * 
 * Register a callback function to handle specific interrupt event types.
 * Multiple callbacks can be registered for the same event type.
 * 
 * @param event_type Event type to register callback for
 * @param callback Callback function to call when event occurs
 * @return 0 on success, negative error code on failure
 */
int interrupt_handler_register_callback(interrupt_event_type_t event_type, interrupt_event_callback_t callback);

/**
 * @brief Unregister an interrupt event callback
 * 
 * @param event_type Event type to unregister
 * @param callback Callback function to unregister
 * @return 0 on success, negative error code on failure
 */
int interrupt_handler_unregister_callback(interrupt_event_type_t event_type, interrupt_event_callback_t callback);

/**
 * @brief Send interrupt event to processing queue
 * 
 * Called from ISR context to send interrupt events to the processing thread.
 * This function is safe to call from interrupt context.
 * 
 * @param event Event to send (will be copied to queue)
 * @return 0 on success, negative error code on failure
 */
int interrupt_handler_send_event(interrupt_event_t* event);

/**
 * @brief Check if interrupt handler is initialized
 * 
 * @return true if initialized, false otherwise
 */
bool interrupt_handler_is_initialized(void);

#endif /* _INTERRUPT_HANDLER_H_ */

