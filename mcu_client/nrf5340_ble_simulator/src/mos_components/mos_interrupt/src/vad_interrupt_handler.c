/*
 * @Author       : Cole
 * @Date         : 2025-12-04 19:26:49
 * @LastEditTime : 2025-12-24 19:33:44
 * @FilePath     : vad_interrupt_handler.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "vad_interrupt_handler.h"

#include <errno.h>
#include <stdbool.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "bsp_gx8002.h"
#include "bspal_audio_i2s.h"
#include "interrupt_handler.h"
#include "pdm_audio_stream.h"

#ifndef USE_I2S_INPUT
#define USE_I2S_INPUT 1  // Default to I2S input mode
#endif

LOG_MODULE_REGISTER(vad_int_handler, LOG_LEVEL_INF);

// I2S active logic GPIO (P0.26) from device tree
#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), i2s_active_logic_gpios)
#define I2S_ACTIVE_LOGIC_GPIO_AVAILABLE 1
static const struct gpio_dt_spec i2s_active_logic = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), i2s_active_logic_gpios);
#else
#define I2S_ACTIVE_LOGIC_GPIO_AVAILABLE 0
#endif

// VAD voice detection GPIO (P0.25) from device tree
// LOW = voice present, HIGH = no voice
#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), vad_voice_detect_gpios)
#define VAD_VOICE_DETECT_GPIO_AVAILABLE 1
static const struct gpio_dt_spec vad_voice_detect = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), vad_voice_detect_gpios);
#else
#define VAD_VOICE_DETECT_GPIO_AVAILABLE 0
#endif

// VAD interrupt state
static bool vad_int_initialized  = false;
static bool i2s_reception_active = false;

// Timeout management
#define VAD_TIMEOUT_BASE_MS 5000  // 5 seconds base timeout
static struct k_timer vad_timeout_timer;
static int32_t        current_timeout_ms = 0;

// Forward declarations
static void vad_timeout_handler(struct k_timer* timer);
static void vad_interrupt_callback(interrupt_event_t* event);
static void vad_timeout_callback(interrupt_event_t* event);

// VAD timeout handler (called when timeout expires - in timer interrupt context)
// Do NOT call blocking functions here - send event to interrupt processing thread instead
static void vad_timeout_handler(struct k_timer* timer)
{
    if (i2s_reception_active)
    {
        // Send timeout event to interrupt processing thread
        // This avoids calling blocking functions (nrfx_i2s_stop) in interrupt context
        interrupt_event_t timeout_event;
        timeout_event.event = INTERRUPT_TYPE_VAD_TIMEOUT;
        timeout_event.tick  = k_uptime_get();
        timeout_event.data  = NULL;

        // Send event to interrupt handler framework (non-blocking)
        int ret = interrupt_handler_send_event(&timeout_event);
        if (ret != 0)
        {
            // Event send failed - this should not happen, but handle gracefully
            // Do NOT log here - logging in interrupt context can cause hangs
        }
    }
}

// Set I2S active logic GPIO (P0.26) to HIGH (I2S started)
static void i2s_active_logic_set_high(void)
{
    if (I2S_ACTIVE_LOGIC_GPIO_AVAILABLE && gpio_is_ready_dt(&i2s_active_logic))
    {
        gpio_pin_set_dt(&i2s_active_logic, 1);
        LOG_INF("🔵 I2S active logic GPIO (P0.26) set to HIGH (I2S started)");
    }
}

// Set I2S active logic GPIO (P0.26) to LOW (I2S stopped)
static void i2s_active_logic_set_low(void)
{
    if (I2S_ACTIVE_LOGIC_GPIO_AVAILABLE && gpio_is_ready_dt(&i2s_active_logic))
    {
        gpio_pin_set_dt(&i2s_active_logic, 0);
        LOG_INF("🔵 I2S active logic GPIO (P0.26) set to LOW (I2S stopped)");
    }
}

// Check P0.25 voice detection GPIO
// Returns: true if voice detected (LOW), false if no voice (HIGH)
static bool vad_check_voice_detect_gpio(void)
{
    if (!VAD_VOICE_DETECT_GPIO_AVAILABLE)
    {
        LOG_WRN("VAD voice detect GPIO (P0.25) not available");
        return false;
    }

    if (vad_voice_detect.port == NULL)
    {
        LOG_ERR("VAD voice detect GPIO device pointer is NULL");
        return false;
    }

    if (!device_is_ready(vad_voice_detect.port))
    {
        LOG_ERR("VAD voice detect GPIO device not ready");
        return false;
    }

    int value = gpio_pin_get_dt(&vad_voice_detect);
    // LOW (0) = voice present, HIGH (1) = no voice
    bool voice_present = (value == 0);

    LOG_INF("🔍 VAD voice detect GPIO (P0.25) value: %d (%s)", value, voice_present ? "voice present" : "no voice");

    return voice_present;
}

// VAD timeout callback (called from interrupt processing thread context)
static void vad_timeout_callback(interrupt_event_t* event)
{
    if (event == NULL)
    {
        LOG_ERR("Invalid timeout event");
        return;
    }

    if (i2s_reception_active)
    {
        LOG_INF("⏱️ VAD timeout (%d ms) - checking voice detection GPIO (P0.25)", current_timeout_ms);
        bool voice_present = vad_check_voice_detect_gpio();
        if (voice_present)
        {
            // Voice still present (LOW level) - extend timeout by 5s and continue
            LOG_INF("🎤 Voice still detected (P0.25 LOW) - extending timeout by %d ms", VAD_TIMEOUT_BASE_MS);

            // Restart timeout timer for another 5 seconds
            current_timeout_ms = VAD_TIMEOUT_BASE_MS;
            k_timer_start(&vad_timeout_timer, K_MSEC(current_timeout_ms), K_NO_WAIT);

            LOG_INF("✅ Timeout extended to %d ms - will check again", current_timeout_ms);
        }
        else
        {
            // No voice detected (HIGH level)
            LOG_INF("🔇 No voice detected (P0.25 HIGH)");

#if USE_I2S_INPUT

            LOG_INF("💡 nRF5340 I2S Master mode: I2S will continue running (generating clocks for external microphones)");
            LOG_INF("💡 Only LC3 encoding will pause, I2S hardware remains active");
            
            // Just reset the timeout flag - I2S hardware stays running
            i2s_reception_active = false;
            current_timeout_ms   = 0;
#else
            LOG_INF("🔇 No voice detected (P0.25 HIGH) - stopping I2S reception");

            // Step 1: Disable GX8002 I2S output (master) - stop sending I2S clocks and data
            uint8_t gx8002_result = bsp_gx8002_disable_i2s();
            if (!gx8002_result)
            {
                LOG_WRN("Failed to disable GX8002 I2S output (may already be disabled)");
            }
            else
            {
                LOG_INF("✅ GX8002 I2S output disabled");
            }

            // Step 2: Stop nRF5340 I2S slave reception
            // LC3 encoding and BLE connection continue working independently
            int ret = pdm_audio_stream_stop_i2s_only();
            if (ret != 0)
            {
                LOG_ERR("Failed to stop nRF5340 I2S slave: %d", ret);
            }

            // Set I2S active logic GPIO to LOW (I2S stopped)
            i2s_active_logic_set_low();

            i2s_reception_active = false;
            current_timeout_ms   = 0;

            LOG_INF("✅ I2S reception stopped - no voice detected (LC3 encoding and BLE continue)");
#endif
        }
    }
}

// External functions from pdm_audio_stream.c
extern int pdm_audio_stream_start_i2s_only(void);
extern int pdm_audio_stream_stop_i2s_only(void);

// VAD interrupt callback (called from interrupt_handler thread context)
static void vad_interrupt_callback(interrupt_event_t* event)
{
    if (event == NULL)
    {
        LOG_ERR("Invalid interrupt event");
        return;
    }

    if (event->event != INTERRUPT_TYPE_VAD_FALLING_EDGE)
    {
        LOG_WRN("Unexpected event type in VAD callback: %u", event->event);
        return;
    }

    // Process VAD falling edge interrupt
#if USE_I2S_INPUT
    // nRF5340 is I2S Master - I2S should run continuously, not controlled by VAD
    // VAD interrupt is ignored in I2S Master mode
    LOG_INF("🎤 VAD interrupt detected (P0.12 falling edge) - ignored in I2S Master mode (I2S runs continuously)");
    LOG_INF("💡 I2S Master mode: I2S hardware runs independently, not controlled by VAD");
#else
    // Old architecture: GX8002 is I2S Master, nRF5340 is Slave
    // VAD interrupt controls I2S start/stop
    if (!i2s_reception_active)
    {
        // First interrupt - enable GX8002 I2S output and start nRF5340 I2S slave reception
        // LC3 encoding will be started by BLE protobuf MicStateConfig message
        LOG_INF(
            "🎤 VAD interrupt detected (P0.12 falling edge) - enabling GX8002 I2S and starting nRF5340 I2S slave "
            "(timeout: %d ms)",
            VAD_TIMEOUT_BASE_MS);

        // Step 1: Enable GX8002 I2S output (master) - this will send I2S clocks and data
        uint8_t gx8002_result = bsp_gx8002_enable_i2s();
        if (!gx8002_result)
        {
            LOG_ERR("Failed to enable GX8002 I2S output - I2S slave will not receive data");
            // Continue anyway - maybe GX8002 I2S is already enabled
        }
        else
        {
            LOG_INF("✅ GX8002 I2S output enabled - GX8002 will send I2S clocks (SCK, LRCK) and data");
        }

        // Step 2: Start nRF5340 I2S slave reception
        int ret = pdm_audio_stream_start_i2s_only();
        if (ret != 0)
        {
            LOG_ERR("Failed to start nRF5340 I2S slave: %d", ret);
            return;
        }

        // Set I2S active logic GPIO to HIGH (I2S started)
        i2s_active_logic_set_high();

        i2s_reception_active = true;
        current_timeout_ms   = VAD_TIMEOUT_BASE_MS;

        // Start timeout timer
        k_timer_start(&vad_timeout_timer, K_MSEC(current_timeout_ms), K_NO_WAIT);

        LOG_INF("✅ I2S reception started (timeout: %d ms) - waiting for BLE command to start LC3 encoding",
                current_timeout_ms);
    }
    else
    {
        // Subsequent interrupt within timeout - reset timeout to 5s (not accumulate)
        current_timeout_ms = VAD_TIMEOUT_BASE_MS;

        LOG_INF("🎤 VAD interrupt detected (P0.12 falling edge) - resetting timeout to %d ms", VAD_TIMEOUT_BASE_MS);

        // Restart timeout timer with reset timeout
        k_timer_stop(&vad_timeout_timer);
        k_timer_start(&vad_timeout_timer, K_MSEC(current_timeout_ms), K_NO_WAIT);

        LOG_INF("✅ Timeout reset to %d ms", current_timeout_ms);
    }
#endif

    // Re-enable interrupt for next falling edge (call BSP function)
    int ret = vad_interrupt_handler_re_enable();
    if (ret != 0)
    {
        LOG_ERR("Failed to re-enable VAD interrupt: %d", ret);
    }
}

// Send VAD interrupt event to processing queue (called from ISR in bsp_gx8002.c)
int vad_interrupt_handler_send_event(void)
{
    interrupt_event_t event;
    event.event = INTERRUPT_TYPE_VAD_FALLING_EDGE;
    event.tick  = k_uptime_get();  // Get current uptime in milliseconds
    event.data  = NULL;            // No additional data needed

    // Send event to interrupt handler framework
    return interrupt_handler_send_event(&event);
}

int vad_interrupt_handler_re_enable(void)
{
    return bsp_gx8002_vad_int_re_enable();
}

// Initialize VAD interrupt handler
int vad_interrupt_handler_init(void)
{
    if (vad_int_initialized)
    {
        LOG_WRN("VAD interrupt handler already initialized");
        return 0;
    }

    // Initialize I2S active logic GPIO (P0.26) - set to LOW initially
    if (I2S_ACTIVE_LOGIC_GPIO_AVAILABLE)
    {
        if (gpio_is_ready_dt(&i2s_active_logic))
        {
            int ret = gpio_pin_configure_dt(&i2s_active_logic, GPIO_OUTPUT);
            if (ret == 0)
            {
                gpio_pin_set_dt(&i2s_active_logic, 0);  // Initialize to LOW
                LOG_INF("✅ I2S active logic GPIO (P0.26) initialized to LOW");
            }
            else
            {
                LOG_WRN("Failed to configure I2S active logic GPIO: %d", ret);
            }
        }
        else
        {
            LOG_WRN("I2S active logic GPIO not ready");
        }
    }

    // Initialize VAD voice detection GPIO (P0.25) - configure as input
    // LOW = voice present, HIGH = no voice
    if (VAD_VOICE_DETECT_GPIO_AVAILABLE)
    {
        if (vad_voice_detect.port != NULL && device_is_ready(vad_voice_detect.port))
        {
            int ret = gpio_pin_configure_dt(&vad_voice_detect, GPIO_INPUT | GPIO_PULL_UP);
            if (ret == 0)
            {
                LOG_INF("✅ VAD voice detection GPIO (P0.25) initialized as input (LOW=voice, HIGH=no voice)");
            }
            else
            {
                LOG_WRN("Failed to configure VAD voice detection GPIO: %d", ret);
            }
        }
        else
        {
            LOG_WRN("VAD voice detection GPIO not available or not ready");
        }
    }

    // Initialize timeout timer
    k_timer_init(&vad_timeout_timer, vad_timeout_handler, NULL);

    // Register VAD interrupt callback with interrupt handler framework
    int ret = interrupt_handler_register_callback(INTERRUPT_TYPE_VAD_FALLING_EDGE, vad_interrupt_callback);
    if (ret != 0)
    {
        LOG_ERR("Failed to register VAD interrupt callback: %d", ret);
        return ret;
    }

    // Register VAD timeout callback with interrupt handler framework
    ret = interrupt_handler_register_callback(INTERRUPT_TYPE_VAD_TIMEOUT, vad_timeout_callback);
    if (ret != 0)
    {
        LOG_ERR("Failed to register VAD timeout callback: %d", ret);
        return ret;
    }

    vad_int_initialized  = true;
    i2s_reception_active = false;
    current_timeout_ms   = 0;

    LOG_INF("✅ VAD interrupt handler initialized");
    LOG_INF("💡 VAD interrupt controls nRF5340 slave I2S: start on falling edge, stop on timeout");
    LOG_INF("💡 I2S timeout: %d ms (resets on each new interrupt, timeout stops I2S immediately)", VAD_TIMEOUT_BASE_MS);
    LOG_INF("💡 LC3 encoding and BLE connection work independently (controlled by MicStateConfig)");

    return 0;
}

// Get current I2S reception status
bool vad_interrupt_handler_is_i2s_active(void)
{
    return i2s_reception_active;
}

// Get current timeout value
int32_t vad_interrupt_handler_get_timeout_ms(void)
{
    return current_timeout_ms;
}
