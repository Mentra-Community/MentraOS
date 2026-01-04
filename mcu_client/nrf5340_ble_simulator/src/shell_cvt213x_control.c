/*
 * @Author       : Cole
 * @Date         : 2025-12-30 18:57:41
 * @LastEditTime : 2026-01-04 15:26:56
 * @FilePath     : shell_cvt213x_control.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */
/**
 * @file shell_cvt213x_control.c
 * @brief CVT213X Shell Debug Commands (Hardware Verification)
 *
 * Provides minimal debug commands for CVT213X touch sensor hardware verification.
 * The CVT213X system auto-initializes at boot in main(), these commands are for
 * debugging and hardware validation only.
 *
 * Copyright (c) MentraOS Contributors 2025
 * SPDX-License-Identifier: Apache-2.0
 */

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>

#include "cvt213x.h"

LOG_MODULE_REGISTER(shell_cvt213x, LOG_LEVEL_INF);

static int cmd_cvt213x_help(const struct shell* shell, size_t argc, char** argv)
{
    shell_print(shell, "");
    shell_print(shell, "🎯 CVT213X Debug Commands:");
    shell_print(shell, "");
    shell_print(shell, "  cvt213x help            - Show this help menu");
    shell_print(shell, "  cvt213x verify          - Verify I2C communication (reads reg 0x0014 via i2c3)");
    shell_print(shell, "  cvt213x status          - Quick status check (runs verify)");
    shell_print(shell, "");
    shell_print(shell, "💡 Note: CVT213X auto-initializes at boot in main()");
    shell_print(shell, "");
    return 0;
}

static int cmd_cvt213x_verify(const struct shell* shell, size_t argc, char** argv)
{
    shell_print(shell, "🔍 Verifying CVT213X I2C (read reg 0x0014)...");
    int ret = app_cvt213x_i2c_verify();
    if (ret == 0)
    {
        shell_print(shell, "✅ CVT213X I2C verify OK");
    }
    else
    {
        shell_error(shell, "❌ CVT213X I2C verify failed: %d", ret);
        shell_error(shell, "💡 Check device tree, wiring, and pull-ups");
    }
    return ret;
}

static int cmd_cvt213x_status(const struct shell* shell, size_t argc, char** argv)
{
    shell_print(shell, "ℹ️  CVT213X quick status (running verify)...");
    return cmd_cvt213x_verify(shell, argc, argv);
}

SHELL_STATIC_SUBCMD_SET_CREATE(sub_cvt213x, SHELL_CMD(help, NULL, "Show cvt213x debug commands", cmd_cvt213x_help),
                               SHELL_CMD(verify, NULL, "Verify I2C communication (read reg 0x0014)",
                                         cmd_cvt213x_verify),
                               SHELL_CMD(status, NULL, "Quick status check (runs verify)", cmd_cvt213x_status),
                               SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(cvt213x, &sub_cvt213x, "CVT213X debug commands (auto-init at boot)", cmd_cvt213x_help);
