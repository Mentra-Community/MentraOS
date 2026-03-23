/*
 * Shell nPM1300 LED Control Module
 * 
 * Shell commands for testing nPM1300 LED control
 * 
 * Available Commands:
 * - led help                    : Show all LED commands
 * - led on <0|1|2>              : Turn LED on
 * - led off <0|1|2>             : Turn LED off
 * - led blink <0|1|2> [freq]    : Start blinking LED (default: 2 Hz, range: 1-10 Hz)
 * - led stop <0|1|2>           : Stop blinking LED
 * - led status [0|1|2]         : Show LED status (all LEDs or specific LED)
 * 
 * Created: 2025-01-XX
 * Author: MentraOS Team
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>

#include "mos_npm1300_led.h"

LOG_MODULE_REGISTER(shell_npm1300_led, LOG_LEVEL_INF);

/**
 * @brief Safely parse unsigned 8-bit integer from string using strtoul
 * @param str String to parse
 * @param value Output parameter for parsed value
 * @return 0 on success, negative error code on failure
 */
static int parse_uint8(const char *str, uint8_t *value)
{
	char *endptr;
	unsigned long val;
	
	if (str == NULL || value == NULL)
	{
		return -EINVAL;
	}
	
	errno = 0;
	val = strtoul(str, &endptr, 10);
	
	/* Check for conversion errors */
	/* endptr == str means no conversion occurred */
	/* *endptr != '\0' means there are unconverted characters */
	if (errno != 0 || *endptr != '\0' || endptr == str)
	{
		return -EINVAL;
	}
	
	/* Check for overflow */
	if (val > UINT8_MAX)
	{
		return -ERANGE;
	}
	
	*value = (uint8_t)val;
	return 0;
}

/**
 * @brief Safely parse unsigned 32-bit integer from string using strtoul
 * @param str String to parse
 * @param value Output parameter for parsed value
 * @return 0 on success, negative error code on failure
 */
static int parse_uint32(const char *str, uint32_t *value)
{
	char *endptr;
	unsigned long val;
	
	if (str == NULL || value == NULL)
	{
		return -EINVAL;
	}
	
	errno = 0;
	val = strtoul(str, &endptr, 10);
	
	/* Check for conversion errors */
	/* endptr == str means no conversion occurred */
	/* *endptr != '\0' means there are unconverted characters */
	if (errno != 0 || *endptr != '\0' || endptr == str)
	{
		return -EINVAL;
	}
	
	/* Check for overflow (ULONG_MAX might be larger than UINT32_MAX) */
	if (val > UINT32_MAX)
	{
		return -ERANGE;
	}
	
	*value = (uint32_t)val;
	return 0;
}

/**
 * @brief LED help command
 */
static int cmd_led_help(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	shell_print(shell, "");
	shell_print(shell, "💡 nPM1300 LED Control Commands:");
	shell_print(shell, "");
	shell_print(shell, "📋 Basic Commands:");
	shell_print(shell, "  led help                     - Show this help menu");
	shell_print(shell, "  led status [0|1|2]          - Show LED status (all or specific)");
	shell_print(shell, "");
	shell_print(shell, "🔛 Control Commands:");
	shell_print(shell, "  led on <0|1|2>               - Turn LED on (solid)");
	shell_print(shell, "  led off <0|1|2>              - Turn LED off");
	shell_print(shell, "");
	shell_print(shell, "✨ Blinking Commands:");
	shell_print(shell, "  led blink <0|1|2> [interval] - Start blinking LED");
	shell_print(shell, "    • interval: time interval in milliseconds (100-10000, default: 500ms)");
	shell_print(shell, "    • LED on time: fixed 100ms");
	shell_print(shell, "    • LED off time: (interval - 100ms)");
	shell_print(shell, "    • Example: 500ms = on 100ms, off 400ms; 3000ms = on 100ms, off 2900ms");
	shell_print(shell, "  led stop <0|1|2>             - Stop blinking LED");
	shell_print(shell, "");
	shell_print(shell, "📊 LED IDs:");
	shell_print(shell, "  0 - LED0 (error indicator)");
	shell_print(shell, "  1 - LED1 (charging indicator)");
	shell_print(shell, "  2 - LED2 (host indicator)");
	shell_print(shell, "");
	shell_print(shell, "💡 Examples:");
	shell_print(shell, "  led on 0                     - Turn LED0 on");
	shell_print(shell, "  led off 1                    - Turn LED1 off");
	shell_print(shell, "  led blink 2                  - Start LED2 blinking (default: 500ms interval)");
	shell_print(shell, "  led blink 0 100               - Start LED0 blinking every 100ms");
	shell_print(shell, "  led blink 1 3000             - Start LED1 blinking every 3000ms (3 seconds)");
	shell_print(shell, "  led stop 2                   - Stop LED2 blinking");
	shell_print(shell, "  led status                   - Show all LEDs status");
	shell_print(shell, "  led status 1                 - Show LED1 status");
	shell_print(shell, "");

	return 0;
}

/**
 * @brief LED on command
 */
static int cmd_led_on(const struct shell *shell, size_t argc, char **argv)
{
	if (argc != 2)
	{
		shell_error(shell, "❌ Usage: led on <0|1|2>");
		shell_print(shell, "Examples:");
		shell_print(shell, "  led on 0    - Turn LED0 on");
		shell_print(shell, "  led on 1    - Turn LED1 on");
		shell_print(shell, "  led on 2    - Turn LED2 on");
		return -EINVAL;
	}

	uint8_t led_id;
	int ret = parse_uint8(argv[1], &led_id);
	if (ret != 0)
	{
		shell_error(shell, "❌ Invalid LED ID: '%s' (must be a number 0-%d)", 
			argv[1], NPM1300_LED_MAX - 1);
		return -EINVAL;
	}
	
	if (led_id >= NPM1300_LED_MAX)
	{
		shell_error(shell, "❌ Invalid LED ID: %d (valid: 0-%d)", led_id, NPM1300_LED_MAX - 1);
		return -EINVAL;
	}

	ret = npm1300_led_on(led_id);
	if (ret == 0)
	{
		shell_print(shell, "✅ LED%d turned ON", led_id);
	}
	else
	{
		shell_error(shell, "❌ Failed to turn on LED%d: %d", led_id, ret);
	}

	return ret;
}

/**
 * @brief LED off command
 */
static int cmd_led_off(const struct shell *shell, size_t argc, char **argv)
{
	if (argc != 2)
	{
		shell_error(shell, "❌ Usage: led off <0|1|2>");
		shell_print(shell, "Examples:");
		shell_print(shell, "  led off 0    - Turn LED0 off");
		shell_print(shell, "  led off 1    - Turn LED1 off");
		shell_print(shell, "  led off 2    - Turn LED2 off");
		return -EINVAL;
	}

	uint8_t led_id;
	int ret = parse_uint8(argv[1], &led_id);
	if (ret != 0)
	{
		shell_error(shell, "❌ Invalid LED ID: '%s' (must be a number 0-%d)", 
			argv[1], NPM1300_LED_MAX - 1);
		return -EINVAL;
	}
	
	if (led_id >= NPM1300_LED_MAX)
	{
		shell_error(shell, "❌ Invalid LED ID: %d (valid: 0-%d)", led_id, NPM1300_LED_MAX - 1);
		return -EINVAL;
	}

	ret = npm1300_led_off(led_id);
	if (ret == 0)
	{
		shell_print(shell, "✅ LED%d turned OFF", led_id);
	}
	else
	{
		shell_error(shell, "❌ Failed to turn off LED%d: %d", led_id, ret);
	}

	return ret;
}

/**
 * @brief LED blink command
 */
static int cmd_led_blink(const struct shell *shell, size_t argc, char **argv)
{
	if (argc < 2 || argc > 3)
	{
		shell_error(shell, "❌ Usage: led blink <0|1|2> [interval_ms]");
		shell_print(shell, "Parameters:");
		shell_print(shell, "  interval_ms: time interval in milliseconds (100-10000, default: 500ms)");
		shell_print(shell, "  LED on time: fixed 100ms, off time: (interval - 100ms)");
		shell_print(shell, "Examples:");
		shell_print(shell, "  led blink 0        - Start LED0 blinking (on 100ms, off 400ms)");
		shell_print(shell, "  led blink 1 200    - Start LED1 blinking (on 100ms, off 100ms)");
		shell_print(shell, "  led blink 2 3000   - Start LED2 blinking (on 100ms, off 2900ms)");
		return -EINVAL;
	}

	uint8_t led_id;
	int ret = parse_uint8(argv[1], &led_id);
	if (ret != 0)
	{
		shell_error(shell, "❌ Invalid LED ID: '%s' (must be a number 0-%d)", 
			argv[1], NPM1300_LED_MAX - 1);
		return -EINVAL;
	}
	
	if (led_id >= NPM1300_LED_MAX)
	{
		shell_error(shell, "❌ Invalid LED ID: %d (valid: 0-%d)", led_id, NPM1300_LED_MAX - 1);
		return -EINVAL;
	}

	uint32_t interval_ms = NPM1300_LED_DEFAULT_INTERVAL_MS;
	if (argc == 3)
	{
		ret = parse_uint32(argv[2], &interval_ms);
		if (ret != 0)
		{
			shell_error(shell, "❌ Invalid interval: '%s' (must be a number)", argv[2]);
			return -EINVAL;
		}
		
		if (interval_ms < NPM1300_LED_MIN_INTERVAL_MS || interval_ms > NPM1300_LED_MAX_INTERVAL_MS)
		{
			shell_error(shell, "❌ Invalid interval: %d ms (valid: %d-%d ms)", 
				interval_ms, NPM1300_LED_MIN_INTERVAL_MS, NPM1300_LED_MAX_INTERVAL_MS);
			return -EINVAL;
		}
	}

	ret = npm1300_led_blink(led_id, interval_ms);
	if (ret == 0)
	{
		shell_print(shell, "✅ LED%d blinking with interval %d ms", led_id, interval_ms);
	}
	else
	{
		shell_error(shell, "❌ Failed to start blinking LED%d: %d", led_id, ret);
	}

	return ret;
}

/**
 * @brief LED stop blinking command
 */
static int cmd_led_stop(const struct shell *shell, size_t argc, char **argv)
{
	if (argc != 2)
	{
		shell_error(shell, "❌ Usage: led stop <0|1|2>");
		shell_print(shell, "Examples:");
		shell_print(shell, "  led stop 0    - Stop LED0 blinking");
		shell_print(shell, "  led stop 1    - Stop LED1 blinking");
		shell_print(shell, "  led stop 2    - Stop LED2 blinking");
		return -EINVAL;
	}

	uint8_t led_id;
	int ret = parse_uint8(argv[1], &led_id);
	if (ret != 0)
	{
		shell_error(shell, "❌ Invalid LED ID: '%s' (must be a number 0-%d)", 
			argv[1], NPM1300_LED_MAX - 1);
		return -EINVAL;
	}
	
	if (led_id >= NPM1300_LED_MAX)
	{
		shell_error(shell, "❌ Invalid LED ID: %d (valid: 0-%d)", led_id, NPM1300_LED_MAX - 1);
		return -EINVAL;
	}

	ret = npm1300_led_stop_blink(led_id);
	if (ret == 0)
	{
		shell_print(shell, "✅ LED%d blinking stopped", led_id);
	}
	else
	{
		shell_error(shell, "❌ Failed to stop blinking LED%d: %d", led_id, ret);
	}

	return ret;
}

/**
 * @brief LED status command
 */
static int cmd_led_status(const struct shell *shell, size_t argc, char **argv)
{
	if (argc == 1)
	{
		/* Show all LEDs status */
		shell_print(shell, "");
		shell_print(shell, "💡 nPM1300 LED Status:");
		shell_print(shell, "");
		
		for (uint8_t i = 0; i < NPM1300_LED_MAX; i++)
		{
			bool is_on = npm1300_led_is_on(i);
			bool is_blinking = npm1300_led_is_blinking(i);
			
			const char *state_str;
			if (is_blinking)
			{
				state_str = "BLINKING";
			}
			else if (is_on)
			{
				state_str = "ON";
			}
			else
			{
				state_str = "OFF";
			}
			
			shell_print(shell, "  LED%d: %s", i, state_str);
		}
		
		shell_print(shell, "");
	}
	else if (argc == 2)
	{
		/* Show specific LED status */
		uint8_t led_id;
		int ret = parse_uint8(argv[1], &led_id);
		if (ret != 0)
		{
			shell_error(shell, "❌ Invalid LED ID: '%s' (must be a number 0-%d)", 
				argv[1], NPM1300_LED_MAX - 1);
			return -EINVAL;
		}
		
		if (led_id >= NPM1300_LED_MAX)
		{
			shell_error(shell, "❌ Invalid LED ID: %d (valid: 0-%d)", led_id, NPM1300_LED_MAX - 1);
			return -EINVAL;
		}
		
		bool is_on = npm1300_led_is_on(led_id);
		bool is_blinking = npm1300_led_is_blinking(led_id);
		
		shell_print(shell, "");
		shell_print(shell, "💡 LED%d Status:", led_id);
		shell_print(shell, "  State: %s", is_blinking ? "BLINKING" : (is_on ? "ON" : "OFF"));
		shell_print(shell, "");
	}
	else
	{
		shell_error(shell, "❌ Usage: led status [0|1|2]");
		shell_print(shell, "  led status       - Show all LEDs status");
		shell_print(shell, "  led status 0     - Show LED0 status");
		return -EINVAL;
	}

	return 0;
}

/* Shell command definitions */
SHELL_STATIC_SUBCMD_SET_CREATE(
	sub_led,
	SHELL_CMD(help, NULL, "Show LED help / 显示LED帮助", cmd_led_help),
	SHELL_CMD(status, NULL, "Show LED status / 显示LED状态", cmd_led_status),
	SHELL_CMD_ARG(on, NULL, "Turn LED on / 打开LED: <0|1|2>", cmd_led_on, 2, 0),
	SHELL_CMD_ARG(off, NULL, "Turn LED off / 关闭LED: <0|1|2>", cmd_led_off, 2, 0),
	SHELL_CMD_ARG(blink, NULL, "Start blinking / 开始闪烁: <0|1|2> [freq]", cmd_led_blink, 2, 1),
	SHELL_CMD_ARG(stop, NULL, "Stop blinking / 停止闪烁: <0|1|2>", cmd_led_stop, 2, 0),
	SHELL_SUBCMD_SET_END
);

SHELL_CMD_REGISTER(led, &sub_led, "nPM1300 LED control commands / nPM1300 LED控制命令",
		   cmd_led_help);

