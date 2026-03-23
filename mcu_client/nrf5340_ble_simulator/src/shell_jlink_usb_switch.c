/*
 * Shell J-Link/USB Switch Control Module
 * 
 * Shell commands for J-Link/USB switch control
 * J-Link/USB切换控制的Shell命令
 * 
 * Available Commands:
 * - jlink_usb help        : Show all J-Link/USB switch commands
 * - jlink_usb status      : Show current switch status
 * - jlink_usb jlink       : Switch to J-Link mode (GPIO LOW)
 * - jlink_usb usb         : Switch to USB mode (GPIO HIGH)
 * - jlink_usb toggle      : Toggle between J-Link and USB mode
 * 
 * Created: 2025-11-20
 * Author: MentraOS Team
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include "mos_jlink_usb_switch_app.h"

LOG_MODULE_REGISTER(shell_jlink_usb_switch, LOG_LEVEL_INF);

/**
 * J-Link/USB switch help command
 */
static int cmd_jlink_usb_help(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "🔌 J-Link/USB Switch Control Commands:");
    shell_print(shell, "");
    shell_print(shell, "📋 Commands:");
    shell_print(shell, "  jlink_usb help        - Show this help menu");
    shell_print(shell, "  jlink_usb status      - Show current switch status");
    shell_print(shell, "  jlink_usb jlink       - Switch to J-Link mode (GPIO LOW)");
    shell_print(shell, "  jlink_usb usb         - Switch to USB mode (GPIO HIGH)");
    shell_print(shell, "  jlink_usb toggle     - Toggle between J-Link and USB mode");
    shell_print(shell, "");
    shell_print(shell, "📊 GPIO Pin: P1.11");
    shell_print(shell, "  HIGH = USB mode | 高电平 = USB模式");
    shell_print(shell, "  LOW  = J-Link mode | 低电平 = J-Link模式");
    shell_print(shell, "");
    shell_print(shell, "📊 Examples:");
    shell_print(shell, "  jlink_usb status     - Check current mode");
    shell_print(shell, "  jlink_usb jlink       - Switch to J-Link mode");
    shell_print(shell, "  jlink_usb usb         - Switch to USB mode");
    shell_print(shell, "  jlink_usb toggle     - Switch to opposite mode");
    shell_print(shell, "");
    
    return 0;
}

/**
 * J-Link/USB switch status command
 */
static int cmd_jlink_usb_status(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "🔌 J-Link/USB Switch Status");
    shell_print(shell, "==========================================");
    shell_print(shell, "GPIO Pin:          P1.11");
    
    bool is_jlink_mode = mos_jlink_usb_switch_app_is_jlink_mode();
    shell_print(shell, "GPIO Initialized:  ✅ Yes");
    shell_print(shell, "Current Mode:      %s", is_jlink_mode ? "🔵 J-Link (LOW)" : "🟢 USB (HIGH)");
    shell_print(shell, "GPIO State:        %s", is_jlink_mode ? "LOW" : "HIGH");
    
    shell_print(shell, "==========================================");
    shell_print(shell, "");
    
    return 0;
}

/**
 * J-Link/USB switch to J-Link mode command
 */
static int cmd_jlink_usb_jlink(const struct shell *shell, size_t argc, char **argv)
{
    int ret = mos_jlink_usb_switch_app_set_jlink_mode();
    if (ret == 0)
    {
        shell_print(shell, "✅ Switched to J-Link mode (GPIO LOW)");
    }
    else
    {
        shell_error(shell, "❌ Failed to switch to J-Link mode: %d", ret);
    }
    return ret;
}

/**
 * J-Link/USB switch to USB mode command
 */
static int cmd_jlink_usb_usb(const struct shell *shell, size_t argc, char **argv)
{
    int ret = mos_jlink_usb_switch_app_set_usb_mode();
    if (ret == 0)
    {
        shell_print(shell, "✅ Switched to USB mode (GPIO HIGH)");
    }
    else
    {
        shell_error(shell, "❌ Failed to switch to USB mode: %d", ret);
    }
    return ret;
}

/**
 * J-Link/USB switch toggle command
 */
static int cmd_jlink_usb_toggle(const struct shell *shell, size_t argc, char **argv)
{
    bool current_mode = mos_jlink_usb_switch_app_is_jlink_mode();
    
    int ret = mos_jlink_usb_switch_app_toggle();
    if (ret == 0)
    {
        bool new_mode = !current_mode;
        shell_print(shell, "✅ Toggled to %s mode (GPIO %s)", 
                    new_mode ? "J-Link" : "USB",
                    new_mode ? "LOW" : "HIGH");
    }
    else
    {
        shell_error(shell, "❌ Failed to toggle switch: %d", ret);
    }
    return ret;
}

/* Shell command definitions */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_jlink_usb,
    SHELL_CMD(help, NULL, "Show J-Link/USB switch commands help", cmd_jlink_usb_help),
    SHELL_CMD(status, NULL, "Show current switch status", cmd_jlink_usb_status),
    SHELL_CMD(jlink, NULL, "Switch to J-Link mode (GPIO LOW)", cmd_jlink_usb_jlink),
    SHELL_CMD(usb, NULL, "Switch to USB mode (GPIO HIGH)", cmd_jlink_usb_usb),
    SHELL_CMD(toggle, NULL, "Toggle between J-Link and USB mode", cmd_jlink_usb_toggle),
    SHELL_SUBCMD_SET_END /* Array terminated. */
);

SHELL_CMD_REGISTER(jlink_usb, &sub_jlink_usb, "J-Link/USB switch control commands", cmd_jlink_usb_help);

