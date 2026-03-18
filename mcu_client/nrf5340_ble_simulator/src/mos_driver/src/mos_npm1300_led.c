/*
 * @Author       : Cole
 * @Date         : 2025-11-22 14:05:45
 * @LastEditTime : 2025-11-22 16:10:32
 * @FilePath     : mos_npm1300_led.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2025 
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_npm1300_led.h"
#include <zephyr/drivers/led.h>
#include <zephyr/devicetree.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <errno.h>

LOG_MODULE_REGISTER(mos_npm1300_led, LOG_LEVEL_INF);

/* Get LED device from device tree */
#define LED_NODE DT_NODELABEL(npm1300_ek_leds)
#if !DT_NODE_EXISTS(LED_NODE)
#error "nPM1300 LED node not found in device tree"
#endif

static const struct device *led_dev = DEVICE_DT_GET(LED_NODE);

/* LED state tracking */
struct led_state {
	bool is_on;
	bool is_blinking;
	uint32_t interval_ms;  /* Blinking interval in milliseconds */
	struct k_work_delayable blink_work;
};

static struct led_state led_states[NPM1300_LED_MAX];

/**
 * @brief Blink work handler - toggles LED state periodically
 */
static void led_blink_work_handler(struct k_work *work)
{
	struct k_work_delayable *dwork = k_work_delayable_from_work(work);

	uint8_t led_id = 0;
	for (uint8_t i = 0; i < NPM1300_LED_MAX; i++)
	{
		if (&led_states[i].blink_work == dwork)
		{
			led_id = i;
			break;
		}
	}
	
	if (!led_states[led_id].is_blinking)
	{
		return;
	}
	
	bool was_on = led_states[led_id].is_on;
	
	led_states[led_id].is_on = !led_states[led_id].is_on;
	
	if (led_states[led_id].is_on)
	{
		led_on(led_dev, led_id);
	}
	else
	{
		led_off(led_dev, led_id);
	}

	uint32_t delay_ms;
	if (was_on)
	{
		if (led_states[led_id].interval_ms > NPM1300_LED_ON_TIME_MS)
		{
			delay_ms = led_states[led_id].interval_ms - NPM1300_LED_ON_TIME_MS;
		}
		else
		{
			delay_ms = 0;
		}
	}
	else
	{
		delay_ms = NPM1300_LED_ON_TIME_MS; 
	}
	
	/* Schedule next toggle */
	k_work_schedule(dwork, K_MSEC(delay_ms));
}

/**
 * @brief Initialize nPM1300 LED driver
 */
int npm1300_led_init(void)
{
	if (!device_is_ready(led_dev))
	{
		LOG_ERR("LED device not ready");
		return -ENODEV;
	}
	
	/* Initialize all LED states */
	memset(led_states, 0, sizeof(led_states));
	
	/* Initialize work queues for blinking */
	for (uint8_t i = 0; i < NPM1300_LED_MAX; i++)
	{
		k_work_init_delayable(&led_states[i].blink_work, led_blink_work_handler);
		led_states[i].is_on = false;
		led_states[i].is_blinking = false;
		led_states[i].interval_ms = NPM1300_LED_DEFAULT_INTERVAL_MS;
	}
	
	/* Turn off all LEDs initially */
	for (uint8_t i = 0; i < NPM1300_LED_MAX; i++)
	{
		led_off(led_dev, i);
	}
	
	LOG_INF("nPM1300 LED driver initialized");
	return 0;
}

/**
 * @brief Turn LED on (solid)
 */
int npm1300_led_on(uint8_t led_id)
{
	if (led_id >= NPM1300_LED_MAX)
	{
		LOG_ERR("Invalid LED ID: %d", led_id);
		return -EINVAL;
	}
	
	/* Stop blinking if active */
	if (led_states[led_id].is_blinking)
	{
		npm1300_led_stop_blink(led_id);
	}
	
	/* Turn LED on */
	int ret = led_on(led_dev, led_id);
	if (ret == 0)
	{
		led_states[led_id].is_on = true;
		LOG_INF("LED %d turned ON", led_id);
	}
	else
	{
		LOG_ERR("Failed to turn on LED %d: %d", led_id, ret);
	}
	
	return ret;
}

/**
 * @brief Turn LED off
 */
int npm1300_led_off(uint8_t led_id)
{
	if (led_id >= NPM1300_LED_MAX)
	{
		LOG_ERR("Invalid LED ID: %d", led_id);
		return -EINVAL;
	}
	
	/* Stop blinking if active */
	if (led_states[led_id].is_blinking)
	{
		npm1300_led_stop_blink(led_id);
	}
	
	/* Turn LED off */
	int ret = led_off(led_dev, led_id);
	if (ret == 0)
	{
		led_states[led_id].is_on = false;
		LOG_INF("LED %d turned OFF", led_id);
	}
	else
	{
		LOG_ERR("Failed to turn off LED %d: %d", led_id, ret);
	}
	
	return ret;
}

/**
 * @brief Start blinking LED with specified interval
 * @param led_id LED ID
 * @param interval_ms Blinking interval in milliseconds (time between each blink)
 */
int npm1300_led_blink(uint8_t led_id, uint32_t interval_ms)
{
	if (led_id >= NPM1300_LED_MAX)
	{
		LOG_ERR("Invalid LED ID: %d", led_id);
		return -EINVAL;
	}
	
	if (interval_ms < NPM1300_LED_MIN_INTERVAL_MS || interval_ms > NPM1300_LED_MAX_INTERVAL_MS)
	{
		LOG_ERR("Invalid interval: %d ms (valid range: %d-%d ms)", 
			interval_ms, NPM1300_LED_MIN_INTERVAL_MS, NPM1300_LED_MAX_INTERVAL_MS);
		return -EINVAL;
	}
	
	/* Stop any existing blinking */
	if (led_states[led_id].is_blinking)
	{
		k_work_cancel_delayable(&led_states[led_id].blink_work);
	}
	
	/* Set blinking state */
	led_states[led_id].is_blinking = true;
	led_states[led_id].interval_ms = interval_ms;
	led_states[led_id].is_on = false;  /* Start with LED off */
	
	/* Turn LED off initially */
	led_off(led_dev, led_id);
	
	/* Calculate delay for first toggle */
	/* Start with LED off, so wait for (interval_ms - 100ms) before turning on */
	uint32_t delay_ms;
	if (interval_ms > NPM1300_LED_ON_TIME_MS)
	{
		delay_ms = interval_ms - NPM1300_LED_ON_TIME_MS;
	}
	else
	{
		/* If interval is too short, turn on immediately */
		delay_ms = 0;
	}
	
	/* Schedule first blink */
	int ret = k_work_schedule(&led_states[led_id].blink_work, K_MSEC(delay_ms));
	if (ret < 0)
	{
		LOG_ERR("Failed to schedule blink work: %d", ret);
		led_states[led_id].is_blinking = false;
		return ret;
	}
	
	LOG_INF("LED %d blinking with interval %d ms", led_id, interval_ms);
	return 0;
}

/**
 * @brief Stop blinking LED (turns LED off)
 */
int npm1300_led_stop_blink(uint8_t led_id)
{
	if (led_id >= NPM1300_LED_MAX)
	{
		LOG_ERR("Invalid LED ID: %d", led_id);
		return -EINVAL;
	}
	
	if (!led_states[led_id].is_blinking)
	{
		return 0;  /* Already not blinking */
	}
	
	/* Cancel blinking work */
	k_work_cancel_delayable(&led_states[led_id].blink_work);
	
	/* Turn LED off */
	led_off(led_dev, led_id);
	
	/* Update state */
	led_states[led_id].is_blinking = false;
	led_states[led_id].is_on = false;
	
	LOG_INF("LED %d blinking stopped", led_id);
	return 0;
}

/**
 * @brief Get current LED state
 */
bool npm1300_led_is_on(uint8_t led_id)
{
	if (led_id >= NPM1300_LED_MAX)
	{
		return false;
	}
	
	return led_states[led_id].is_on || led_states[led_id].is_blinking;
}

/**
 * @brief Get blinking status
 */
bool npm1300_led_is_blinking(uint8_t led_id)
{
	if (led_id >= NPM1300_LED_MAX)
	{
		return false;
	}
	
	return led_states[led_id].is_blinking;
}
