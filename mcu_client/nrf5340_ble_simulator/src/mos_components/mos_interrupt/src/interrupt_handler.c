/*
 * @Author       : Cole
 * @Date         : 2025-12-04 19:34:06
 * @LastEditTime : 2026-01-26 10:07:54
 * @FilePath     : interrupt_handler.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "interrupt_handler.h"

#include <errno.h>
#include <stdbool.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(interrupt_handler, LOG_LEVEL_INF);

// Interrupt processing thread configuration
#define INTERRUPT_THREAD_STACK_SIZE 2048
#define INTERRUPT_THREAD_PRIORITY   5
#define INTERRUPT_QUEUE_SIZE        5

// Interrupt processing thread
K_THREAD_STACK_DEFINE(interrupt_thread_stack, INTERRUPT_THREAD_STACK_SIZE);
static struct k_thread interrupt_thread_data;

// Interrupt message queue
K_MSGQ_DEFINE(interrupt_queue, sizeof(interrupt_event_t), INTERRUPT_QUEUE_SIZE, 4);

// Interrupt metadata structure
typedef struct
{
    const char* name;         // Interrupt name;; 中断名称
    const char* description;  // Interrupt description; 中断描述
} interrupt_metadata_t;

// Interrupt metadata table (static data for each interrupt type)
static const interrupt_metadata_t interrupt_metadata[INTERRUPT_TYPE_MAX_COUNT] = {
    [INTERRUPT_TYPE_UNKNOWN] = {"UNKNOWN", "Unknown or invalid interrupt"},

    // Button interrupt metadata | 按键中断元数据
    [INTERRUPT_TYPE_BUTTON_PRESSED]  = {"BUTTON_PRESSED", "Button pressed interrupt (P0.23)"},
    [INTERRUPT_TYPE_BUTTON_RELEASED] = {"BUTTON_RELEASED", "Button released interrupt (P0.23)"},

};


static interrupt_callback_entry_t callback_registry[INTERRUPT_TYPE_MAX_COUNT];
static bool                       initialized = false;


// Interrupt processing thread function
// Unified interrupt handler - processes all interrupt events from queue
static void interrupt_thread(void* p1, void* p2, void* p3)
{
    (void)p1;
    (void)p2;
    (void)p3;

    LOG_INF("Interrupt processing thread started");

    interrupt_event_t event;

    while (1)
    {
        // Wait for interrupt event from message queue (blocking)
        if (k_msgq_get(&interrupt_queue, &event, K_FOREVER) == 0)
        {
            LOG_INF("Processing interrupt event: %s", interrupt_metadata[event.event].name);

            // Get callback registry entry for this interrupt type
            interrupt_callback_entry_t* entry = &callback_registry[event.event];

            // Check if callback is registered
            if (entry->registered && entry->callback != NULL)
            {
                // Call the registered callback
                entry->callback(&event);
            }
            else
            {
                LOG_WRN("No callback registered for %s interrupt", interrupt_metadata[event.event].name);
            }
        }
    }
}

// Initialize interrupt handler framework
int interrupt_handler_init(void)
{
    if (initialized)
    {
        LOG_WRN("Interrupt handler already initialized");
        return 0;
    }

    // Initialize callback registry (clear all entries)
    for (uint32_t i = 0; i < INTERRUPT_TYPE_MAX_COUNT; i++)
    {
        callback_registry[i].callback    = NULL;
        callback_registry[i].name        = interrupt_metadata[i].name;
        callback_registry[i].description = interrupt_metadata[i].description;
        callback_registry[i].registered  = false;
    }

    // Start interrupt processing thread
    k_thread_create(&interrupt_thread_data, interrupt_thread_stack, K_THREAD_STACK_SIZEOF(interrupt_thread_stack),
                    interrupt_thread, NULL, NULL, NULL, INTERRUPT_THREAD_PRIORITY, 0, K_NO_WAIT);
    k_thread_name_set(&interrupt_thread_data, "process_interrupt");

    initialized = true;

    LOG_INF("✅ Interrupt handler framework initialized");
    LOG_INF("💡 Thread name: process_interrupt, stack: %d bytes, queue: %d events", INTERRUPT_THREAD_STACK_SIZE,
            INTERRUPT_QUEUE_SIZE);

    return 0;
}

// Register an interrupt event callback
int interrupt_handler_register_callback(interrupt_event_type_t event_type, interrupt_event_callback_t callback)
{
    if (!initialized)
    {
        LOG_ERR("Interrupt handler not initialized");
        return -ENODEV;
    }

    if (callback == NULL)
    {
        LOG_ERR("Invalid callback function");
        return -EINVAL;
    }

    // Validate event type
    if (event_type >= INTERRUPT_TYPE_MAX_COUNT || event_type == INTERRUPT_TYPE_UNKNOWN)
    {
        LOG_ERR("Invalid interrupt event type: %u", event_type);
        return -EINVAL;
    }

    // Get registry entry
    interrupt_callback_entry_t* entry = &callback_registry[event_type];

    // Check if callback already registered
    if (entry->registered)
    {
        LOG_WRN("Callback already registered for %s (%s), overwriting", entry->name, entry->description);
    }

    // Register callback with metadata
    entry->callback   = callback;
    entry->registered = true;
    // name and description are already set from interrupt_metadata during init

    LOG_INF("✅ Registered callback for interrupt: %s (%s)", entry->name, entry->description);

    return 0;
}

// Unregister an interrupt event callback
int interrupt_handler_unregister_callback(interrupt_event_type_t event_type, interrupt_event_callback_t callback)
{
    if (!initialized)
    {
        return -ENODEV;
    }

    // Validate event type
    if (event_type >= INTERRUPT_TYPE_MAX_COUNT || event_type == INTERRUPT_TYPE_UNKNOWN)
    {
        LOG_ERR("Invalid interrupt event type: %u", event_type);
        return -EINVAL;
    }

    // Get registry entry
    interrupt_callback_entry_t* entry = &callback_registry[event_type];

    // Check if callback is registered
    if (!entry->registered)
    {
        LOG_WRN("No callback registered for %s (%s)", entry->name, entry->description);
        return -ENOENT;
    }

    // Optional: Verify callback matches (if callback parameter is provided)
    if (callback != NULL && entry->callback != callback)
    {
        LOG_WRN("Callback mismatch for %s (%s)", entry->name, entry->description);
        return -EINVAL;
    }

    // Unregister callback
    entry->callback   = NULL;
    entry->registered = false;
    // Keep name and description for reference

    LOG_INF("✅ Unregistered callback for interrupt: %s (%s)", entry->name, entry->description);

    return 0;
}

// Send interrupt event to processing queue (called from ISR)
int interrupt_handler_send_event(interrupt_event_t* event)
{
    if (!initialized)
    {
        return -ENODEV;
    }

    if (event == NULL)
    {
        return -EINVAL;
    }

    int ret = k_msgq_put(&interrupt_queue, event, K_NO_WAIT);
    if (ret != 0)
    {
        LOG_ERR("Failed to enqueue interrupt event (type: %u): %d", event->event, ret);
        return ret;
    }

    return 0;
}

// Check if interrupt handler is initialized
bool interrupt_handler_is_initialized(void)
{
    return initialized;
}
