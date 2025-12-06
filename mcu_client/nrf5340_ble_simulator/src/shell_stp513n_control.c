/**
 * @file shell_stp513n_control.c
 * @brief STP513N Shell Control Commands
 * 
 * @author MentraOS Team
 * @date 2025-12-24
 * 
 * Copyright (c) MentraOS Contributors 2025
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include "stp513n.h"

LOG_MODULE_REGISTER(shell_stp513n, LOG_LEVEL_INF);

/**
 * @brief STP513N help command
 */
static int cmd_stp513n_help(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "📱 STP513N Touch Panel Control Commands:");
    shell_print(shell, "");
    shell_print(shell, "📋 Available Commands:");
    shell_print(shell, "  stp513n help                    - Show this help menu");
    shell_print(shell, "  stp513n init                    - Initialize STP513N driver");
    shell_print(shell, "  stp513n status                  - Check initialization status");
    shell_print(shell, "  stp513n reset_connect          - Reset and connect (within 100ms)");
    shell_print(shell, "  stp513n soft_reset             - Soft reset STP513N (I2C command)");
    shell_print(shell, "  stp513n connect                - Connect to STP513N test mode");
    shell_print(shell, "  stp513n test_i2c               - Test I2C communication (scans bus)");
    shell_print(shell, "  stp513n read_eeprom <addr>     - Read EEPROM byte (0-63)");
    shell_print(shell, "  stp513n read_config            - Read full configuration (64 bytes)");
    shell_print(shell, "  stp513n update_config          - Update configuration from default");
    shell_print(shell, "  stp513n eeprom_status          - Get EEPROM write status");
    shell_print(shell, "");
    
    return 0;
}

/**
 * @brief Initialize STP513N
 */
static int cmd_stp513n_init(const struct shell *shell, size_t argc, char **argv)
{
    if (stp513n_is_initialized())
    {
        shell_print(shell, "ℹ️  STP513N already initialized");
        return 0;
    }

    int ret = stp513n_init();
    if (ret == 0)
    {
        shell_print(shell, "✅ STP513N initialized successfully");
    }
    else
    {
        shell_error(shell, "❌ Failed to initialize STP513N: %d", ret);
    }
    return ret;
}

/**
 * @brief Get STP513N initialization status
 */
static int cmd_stp513n_status(const struct shell *shell, size_t argc, char **argv)
{
    if (stp513n_is_initialized())
    {
        shell_print(shell, "✅ STP513N is initialized");
    }
    else
    {
        shell_print(shell, "❌ STP513N is not initialized");
        shell_print(shell, "💡 Use 'stp513n init' to initialize");
    }
    return 0;
}

/**
 * @brief Reset and connect STP513N (within 100ms window)
 */
static int cmd_stp513n_reset_connect(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "🔄 Resetting STP513N and connecting (within 100ms window)...");
    int ret = stp513n_reset_and_connect();
    if (ret == 0)
    {
        shell_print(shell, "✅ STP513N reset and connect successful");
    }
    else
    {
        shell_error(shell, "❌ Failed to reset and connect STP513N: %d", ret);
    }
    return ret;
}

/**
 * @brief Soft reset STP513N
 */
static int cmd_stp513n_soft_reset(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "🔄 Soft resetting STP513N (I2C command)...");
    int ret = stp513n_soft_reset();
    if (ret == 0)
    {
        shell_print(shell, "✅ STP513N soft reset completed");
    }
    else
    {
        shell_error(shell, "❌ Failed to soft reset STP513N: %d", ret);
    }
    return ret;
}

/**
 * @brief Connect to STP513N test mode
 */
static int cmd_stp513n_connect(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "🔗 Connecting to STP513N test mode...");
    shell_print(shell, "💡 Note: Chip must be in upgrade window (100ms after reset)");
    shell_print(shell, "💡 Try 'stp513n soft_reset' first if connection fails");
    
    uint8_t ret = stp513n_connect();
    if (ret == 0)
    {
        shell_print(shell, "✅ STP513N connected successfully");
    }
    else
    {
        shell_error(shell, "❌ Failed to connect to STP513N");
        shell_error(shell, "💡 Possible causes:");
        shell_error(shell, "   - I2C communication failure (check wiring)");
        shell_error(shell, "   - Chip not powered on");
        shell_error(shell, "   - Wrong I2C address (expected 0x%02X)", STP513N_I2C_ADDR);
        shell_error(shell, "   - Chip not in upgrade window (try soft_reset first)");
    }
    return ret;
}

/**
 * @brief Read EEPROM byte
 */
static int cmd_stp513n_read_eeprom(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2)
    {
        shell_error(shell, "Usage: stp513n read_eeprom <addr>");
        shell_error(shell, "Example: stp513n read_eeprom 0");
        return -EINVAL;
    }

    unsigned long addr = strtoul(argv[1], NULL, 10);
    if (addr >= 64)
    {
        shell_error(shell, "Invalid EEPROM address (0-63): %lu", addr);
        return -EINVAL;
    }

    uint8_t value = stp513n_read_eeprom((uint8_t)addr);
    if (value == 0xFF)
    {
        shell_error(shell, "❌ Failed to read EEPROM address %lu", addr);
        return -EIO;
    }

    shell_print(shell, "EEPROM[%lu] = 0x%02X (%d)", addr, value, value);
    return 0;
}

/**
 * @brief Read full configuration
 */
static int cmd_stp513n_read_config(const struct shell *shell, size_t argc, char **argv)
{
    uint8_t config[64];
    
    shell_print(shell, "📖 Reading STP513N configuration...");
    int ret = stp513n_read_config(config, 64);
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to read configuration: %d", ret);
        return ret;
    }

    shell_print(shell, "Configuration (64 bytes):");
    for (int i = 0; i < 64; i++)
    {
        if (i % 16 == 0)
        {
            shell_print(shell, "");
            shell_fprintf(shell, SHELL_NORMAL, "%02X: ", i);
        }
        shell_fprintf(shell, SHELL_NORMAL, "%02X ", config[i]);
    }
    shell_print(shell, "");
    
    return 0;
}

/**
 * @brief Update configuration from default
 */
static int cmd_stp513n_update_config(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "🔄 Updating STP513N configuration...");
    shell_print(shell, "⚠️  This will reset the chip and enter test mode");
    
    // Use default configuration
    // const uint8_t default_config[64] = {
    //     0x56, 0x00, 0x00, 0x00, 0xf7, 0x05, 0xff, 0x1f, 0x61, 0x00, 0x62, 0xb0, 0x24, 0x3f, 0x3f, 0x3f,
    //     0x00, 0xf0, 0x02, 0x00, 0x00, 0x00, 0x8b, 0x88, 0x25, 0x00, 0x21, 0x3e, 0x3e, 0x3e, 0x00, 0x11,
    //     0x20, 0x18, 0xdb, 0x2f, 0xdb, 0x54, 0x80, 0x98, 0x10, 0x40, 0x98, 0x44, 0x49, 0xcc, 0x22, 0x0f,
    //     0x14, 0x40, 0x98, 0x44, 0x49, 0xcc, 0x22, 0x0f, 0x38, 0x40, 0x98, 0x22, 0x29, 0xc9, 0x22, 0x16
    // };// Default configuration: output IO is GPIO0, LOW indicates wearing, floating indicates not wearing；默认配置输出IO为GPIO0,IO低电平表示佩戴，浮空表示未佩戴
    uint8_t default_config[64]=
    {
        0x56,0x00,0x00,0x00,0xf7,0x05,0xff,0x1f,0x61,0x00,0x62,0xb0,0x3f,0x3f,0x24,0x3f,
        0x00,0xf0,0x02,0x00,0x00,0x00,0x88,0x8b,0x25,0x00,0x21,0x3e,0x3e,0x3e,0x00,0x11,
        0x20,0x18,0xdb,0x2f,0xdb,0x54,0x80,0x98,0x10,0x40,0x98,0x44,0x49,0xcc,0x22,0x0f,
        0x14,0x40,0x98,0x44,0x49,0xcc,0x22,0x0f,0x38,0x40,0x98,0x22,0x29,0xc9,0x22,0x16
    };// SPT513N_XYAR_NEX_0xA2454BE3_V01.bin; After updating to IC, output IO switches to GPIO02, LOW indicates wearing, floating indicates not wearing；SPT513N_XYAR_NEX_0xA2454BE3_V01.bin;更新到IC里，输出IO就切换到了GPIO02上,IO低电平表示佩戴，浮空表示未佩戴


    int ret = stp513n_update_config(default_config, 64);
    if (ret == 0)
    {
        shell_print(shell, "✅ Configuration updated successfully");
    }
    else
    {
        shell_error(shell, "❌ Failed to update configuration: %d", ret);
    }
    return ret;
}

/**
 * @brief Get EEPROM status
 */
static int cmd_stp513n_eeprom_status(const struct shell *shell, size_t argc, char **argv)
{
    uint8_t status = stp513n_get_eeprom_status();
    if (status)
    {
        shell_print(shell, "EEPROM status: BUSY (write in progress)");
    }
    else
    {
        shell_print(shell, "EEPROM status: READY");
    }
    return 0;
}

/**
 * @brief Test I2C communication
 */
static int cmd_stp513n_test_i2c(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "🔍 Testing I2C communication with STP513N (address 0x%02X)...", STP513N_I2C_ADDR);
    
    // First, scan I2C bus to see if device exists
    shell_print(shell, "Scanning I2C1 bus for devices...");
    uint8_t found_addr = 0;
    int scan_ret = stp513n_scan_i2c(&found_addr);
    
    if (scan_ret != 0)
    {
        shell_error(shell, "❌ STP513N not found on I2C1 bus");
        if (found_addr != 0)
        {
            shell_error(shell, "⚠️  Found device at 0x%02X (expected 0x%02X)", found_addr, STP513N_I2C_ADDR);
        }
        shell_error(shell, "💡 Troubleshooting:");
        shell_error(shell, "   1. Check I2C1 bus wiring (SDA, SCL)");
        shell_error(shell, "   2. Verify STP513N power supply");
        shell_error(shell, "   3. Check I2C pull-up resistors (typically 4.7kΩ)");
        shell_error(shell, "   4. Verify I2C address (should be 0x%02X)", STP513N_I2C_ADDR);
        return scan_ret;
    }
    
    shell_print(shell, "✅ STP513N device found on I2C1 bus");
    
    // Try to read register 0xF0 (should be 0x80 in upgrade/test mode)
    shell_print(shell, "Reading register 0xF0 (expected 0x80 in test mode)...");
    uint8_t value = stp513n_read_reg(0xF0);
    
    if (value == 0xFF)
    {
        shell_error(shell, "❌ I2C communication failed - cannot read register");
        shell_error(shell, "💡 Device found but register read failed");
        shell_error(shell, "💡 Try 'stp513n soft_reset' to reset chip");
        return -EIO;
    }
    else if (value == 0x80)
    {
        shell_print(shell, "✅ I2C communication OK - Chip is in test/upgrade mode (0xF0 = 0x80)");
    }
    else
    {
        shell_print(shell, "⚠️  I2C communication OK but unexpected value: 0xF0 = 0x%02X (expected 0x80)", value);
        shell_print(shell, "💡 Chip may not be in test mode - try 'stp513n soft_reset' first");
    }
    
    return 0;
}

// Shell command definitions
SHELL_STATIC_SUBCMD_SET_CREATE(
    sub_stp513n,
    SHELL_CMD(help, NULL, "Show stp513n commands help", cmd_stp513n_help),
    SHELL_CMD(init, NULL, "Initialize STP513N driver", cmd_stp513n_init),
    SHELL_CMD(status, NULL, "Check STP513N initialization status", cmd_stp513n_status),
    SHELL_CMD(reset_connect, NULL, "Reset and connect STP513N (within 100ms)", cmd_stp513n_reset_connect),
    SHELL_CMD(soft_reset, NULL, "Soft reset STP513N (I2C command)", cmd_stp513n_soft_reset),
    SHELL_CMD(connect, NULL, "Connect to STP513N test mode", cmd_stp513n_connect),
    SHELL_CMD_ARG(read_eeprom, NULL, "Read EEPROM: <addr> (0-63)", cmd_stp513n_read_eeprom, 2, 0),
    SHELL_CMD(read_config, NULL, "Read full configuration (64 bytes)", cmd_stp513n_read_config),
    SHELL_CMD(update_config, NULL, "Update configuration from default", cmd_stp513n_update_config),
    SHELL_CMD(eeprom_status, NULL, "Get EEPROM write status", cmd_stp513n_eeprom_status),
    SHELL_CMD(test_i2c, NULL, "Test I2C communication", cmd_stp513n_test_i2c),
    SHELL_SUBCMD_SET_END
);  

SHELL_CMD_REGISTER(stp513n, &sub_stp513n, "STP513N touch panel control commands", cmd_stp513n_help);
