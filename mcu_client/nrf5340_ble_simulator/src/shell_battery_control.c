/*
 * Shell Battery Control Module
 * 
 * Battery monitoring and fuel gauge control commands
 * 
 * Available Commands:
 * - battery help              : Show all battery commands
 * - battery status             : Show current battery status
 * - battery monitor start      : Start continuous battery monitoring
 * - battery monitor stop       : Stop battery monitoring
 * - battery monitor status     : Show monitoring status
 * 
 * Created: 2025-10-28
 * Author: MentraOS Team
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <stdbool.h>
#include <errno.h>

#include "mos_fuel_gauge.h"

LOG_MODULE_REGISTER(shell_battery, LOG_LEVEL_INF);

/* nPM1300 charge status bitmasks (matching mos_fuel_gauge.c) / nPM1300充电状态位掩码（与mos_fuel_gauge.c一致） */
#define CHG_STATUS_COMPLETE_MASK (1 << 1)  /* 0x02 / 充电完成 */
#define CHG_STATUS_TRICKLE_MASK  (1 << 2)  /* 0x04 / 涓流充电 */
#define CHG_STATUS_CC_MASK       (1 << 3)  /* 0x08 / 恒流充电 */
#define CHG_STATUS_CV_MASK       (1 << 4)  /* 0x10 / 恒压充电 */

static int cmd_battery_help(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	shell_print(shell, "");
	shell_print(shell, "🔋 Battery Control Commands:");
	shell_print(shell, "");
	shell_print(shell, "📋 Basic Commands:");
	shell_print(shell, "  battery help                     - Show this help menu");
	shell_print(shell, "  battery status                   - Show current battery status");
	shell_print(shell, "  battery charge-mode              - Show current charging mode");
	shell_print(shell, "");
	shell_print(shell, "🧪 Monitor Commands:");
	shell_print(shell, "  battery monitor start            - Start continuous monitoring");
	shell_print(shell, "  battery monitor stop             - Stop monitoring");
	shell_print(shell, "  battery monitor status           - Show monitoring status");
	shell_print(shell, "");
	shell_print(shell, "📊 Status shows: Voltage, Current, Temperature, SoC%%, TTE, TTF");
	shell_print(shell, "");

	return 0;
}

static int cmd_battery_status(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	shell_print(shell, "");
	shell_print(shell, "🔋 Current Battery Status / 当前电池状态:");
	
	/* Trigger one-time battery status update / 触发一次性电池状态更新 */
	battery_monitor();
	
	shell_print(shell, "✅ Status updated, check logs above / 状态已更新，请查看上方日志");
	shell_print(shell, "");

	return 0;
}

static int cmd_battery_charge_mode(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	int32_t chg_status;
	int ret;
	const char *mode_name_en = "Unknown";
	const char *mode_name_cn = "未知";

	shell_print(shell, "");
	shell_print(shell, "🔌 Charging Mode / 充电模式:");

	ret = battery_get_charge_status(&chg_status);
	if (ret < 0)
	{
		shell_print(shell, "❌ Failed to read charge status: %d / 读取充电状态失败: %d", ret, ret);
		shell_print(shell, "");
		return ret;
	}

	/* Parse charge status and show mode / 解析充电状态并显示模式 */
	if (chg_status & CHG_STATUS_COMPLETE_MASK)
	{
		mode_name_en = "Complete";
		mode_name_cn = "完成";
	}
	else if (chg_status & CHG_STATUS_TRICKLE_MASK)
	{
		mode_name_en = "Trickle";
		mode_name_cn = "涓流充电";
	}
	else if (chg_status & CHG_STATUS_CC_MASK)
	{
		mode_name_en = "Constant Current (CC)";
		mode_name_cn = "恒流充电";
	}
	else if (chg_status & CHG_STATUS_CV_MASK)
	{
		mode_name_en = "Constant Voltage (CV)";
		mode_name_cn = "恒压充电";
	}
	else
	{
		mode_name_en = "Idle";
		mode_name_cn = "空闲";
	}

	shell_print(shell, "  Status register: 0x%02X / 状态寄存器: 0x%02X", chg_status, chg_status);
	shell_print(shell, "  Mode: %s / %s", mode_name_en, mode_name_cn);
	shell_print(shell, "");

	return 0;
}

static int cmd_battery_monitor_start(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	if (battery_monitor_is_active())
	{
		shell_print(shell, "⚠️  Battery monitoring already running / 电池监控已在运行");
		return 0;
	}

	battery_monitor_start();
	shell_print(shell, "✅ Battery monitoring started (interval: %d ms) / 电池监控已启动(间隔: %d毫秒)",
		    BATTERY_MONITOR_INTERVAL_MS, BATTERY_MONITOR_INTERVAL_MS);
	shell_print(shell, "");

	return 0;
}

static int cmd_battery_monitor_stop(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	if (!battery_monitor_is_active())
	{
		shell_print(shell, "⚠️  Battery monitoring not running / 电池监控未运行");
		return 0;
	}

	battery_monitor_stop();
	shell_print(shell, "✅ Battery monitoring stopped / 电池监控已停止");
	shell_print(shell, "");

	return 0;
}

static int cmd_battery_monitor_status(const struct shell *shell, size_t argc, char **argv)
{
	ARG_UNUSED(argc);
	ARG_UNUSED(argv);

	bool active = battery_monitor_is_active();
	shell_print(shell, "");
	shell_print(shell, "📊 Battery Monitor Status / 电池监控状态:");
	shell_print(shell, "  Active: %s / %s", active ? "Yes" : "No", active ? "是" : "否");
	shell_print(shell, "  Interval: %d ms / %d毫秒", BATTERY_MONITOR_INTERVAL_MS, BATTERY_MONITOR_INTERVAL_MS);
	shell_print(shell, "  Method: Work Queue / 工作队列");
	shell_print(shell, "");

	return 0;
}

/* Shell command definitions / Shell命令定义 */
SHELL_STATIC_SUBCMD_SET_CREATE(
	sub_battery_monitor,
	SHELL_CMD(start, NULL, "Start battery monitoring / 启动电池监控",
		  cmd_battery_monitor_start),
	SHELL_CMD(stop, NULL, "Stop battery monitoring / 停止电池监控",
		  cmd_battery_monitor_stop),
	SHELL_CMD(status, NULL, "Show monitoring status / 显示监控状态",
		  cmd_battery_monitor_status),
	SHELL_SUBCMD_SET_END
);

SHELL_STATIC_SUBCMD_SET_CREATE(
	sub_battery,
	SHELL_CMD(help, NULL, "Show battery help / 显示电池帮助", cmd_battery_help),
	SHELL_CMD(status, NULL, "Show battery status / 显示电池状态", cmd_battery_status),
	SHELL_CMD(charge-mode, NULL, "Show charging mode / 显示充电模式", cmd_battery_charge_mode),
	SHELL_CMD(monitor, &sub_battery_monitor, "Battery monitoring control / 电池监控控制",
		  cmd_battery_help),
	SHELL_SUBCMD_SET_END
);

SHELL_CMD_REGISTER(battery, &sub_battery, "Battery control commands / 电池控制命令",
		   cmd_battery_help);

