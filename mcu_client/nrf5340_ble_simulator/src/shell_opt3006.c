/*
 * Shell OPT3006 Control Module
 * 
 * Manual OPT3006 ambient light sensor control commands
 * 
 * Available Commands:
 * - opt3006 help              : Show all OPT3006 commands
 * - opt3006 info              : Show sensor information
 * - opt3006 read              : Read current illuminance value
 * - opt3006 test [count]      : Run continuous test (default: infinite)
 * - opt3006 config            : Show current configuration
 * - opt3006 mode <mode>       : Set conversion mode (continuous/single/shutdown)
 * - opt3006 ct <time>         : Set conversion time (100/800 ms)
 * 
 * Created: 2025-10-16
 * Author: MentraOS Team
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <stdlib.h>

#include "mos_opt3006.h"

LOG_MODULE_REGISTER(shell_opt3006, LOG_LEVEL_INF);

// Test control variables
static bool test_running = false;
static k_tid_t test_thread_id = NULL;

/**
 * OPT3006 help command
 */
static int cmd_opt3006_help(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "🌞 OPT3006 Ambient Light Sensor Commands:");
    shell_print(shell, "");
    shell_print(shell, "📋 Basic Commands:");
    shell_print(shell, "  opt3006 help                     - Show this help menu");
    shell_print(shell, "  opt3006 info                     - Show sensor information");
    shell_print(shell, "  opt3006 read                     - Read current illuminance (one shot)");
    shell_print(shell, "  opt3006 config                   - Show current configuration");
    shell_print(shell, "");
    shell_print(shell, "🧪 Test Commands:");
    shell_print(shell, "  opt3006 test [count]             - Run continuous measurement test");
    shell_print(shell, "                                     count: number of samples (default: 100)");
    shell_print(shell, "                                     Use 0 for infinite (Ctrl+C to stop)");
    shell_print(shell, "");
    shell_print(shell, "⚙️  Configuration Commands:");
    shell_print(shell, "  opt3006 mode <mode>              - Set conversion mode:");
    shell_print(shell, "    • continuous                     Continuous measurement");
    shell_print(shell, "    • single                         Single-shot measurement");
    shell_print(shell, "    • shutdown                       Power down mode");
    shell_print(shell, "  opt3006 ct <time>                - Set conversion time:");
    shell_print(shell, "    • 100                            100ms (fast, lower precision)");
    shell_print(shell, "    • 800                            800ms (slow, high precision)");
    shell_print(shell, "");
    shell_print(shell, "🔧 Advanced Debug Commands:");
    shell_print(shell, "  opt3006 read_reg <addr>          - Read register (hex addr: 0x00-0x7F)");
    shell_print(shell, "  opt3006 write_reg <addr> <val>   - Write register (hex values)");
    shell_print(shell, "");
    shell_print(shell, "📊 Examples:");
    shell_print(shell, "  opt3006 read                     - Quick lux reading");
    shell_print(shell, "  opt3006 test 10                  - Measure 10 times");
    shell_print(shell, "  opt3006 mode continuous          - Enable continuous mode");
    shell_print(shell, "  opt3006 ct 800                   - Set 800ms conversion time");
    shell_print(shell, "  opt3006 read_reg 0x01            - Read config register");
    shell_print(shell, "  opt3006 write_reg 0x01 0xCC10    - Write config register");
    shell_print(shell, "");
    
    return 0;
}

/**
 * OPT3006 info command - show sensor information
 */
static int cmd_opt3006_info(const struct shell *shell, size_t argc, char **argv)
{
    uint16_t config;
    int ret;
    
    shell_print(shell, "");
    shell_print(shell, "🌞 OPT3006 Ambient Light Sensor Information");
    shell_print(shell, "==========================================");
    shell_print(shell, "Sensor:          OPT3006");
    shell_print(shell, "Manufacturer:    Texas Instruments");
    shell_print(shell, "I2C Address:     0x%02X (7-bit)", OPT3006_I2C_ADDR);
    shell_print(shell, "");
    
    // Read configuration
    ret = opt3006_get_config(&config);
    if (ret == 0)
    {
        uint8_t rn = (config >> OPT3006_CONFIG_RN_SHIFT) & 0x0F;
        uint8_t ct = (config >> OPT3006_CONFIG_CT_BIT) & 0x01;
        uint8_t mode = (config >> OPT3006_CONFIG_M_SHIFT) & 0x03;
        
        shell_print(shell, "Configuration:   0x%04X", config);
        shell_print(shell, "  Range Number:  0x%X (%s)", rn, 
                    rn == 0x0C ? "AUTO" : "Manual");
        shell_print(shell, "  Conv Time:     %s", ct ? "800ms" : "100ms");
        shell_print(shell, "  Mode:          %s", 
                    mode == 0 ? "Shutdown" :
                    mode == 1 ? "Single-shot" : "Continuous");
    }
    else
    {
        shell_print(shell, "Configuration:   Read failed (%d)", ret);
    }
    
    shell_print(shell, "");
    shell_print(shell, "Measurement Range: 0.01 - 83865.60 lux");
    shell_print(shell, "Resolution:        0.01 lux/LSB (auto-range)");
    shell_print(shell, "==========================================");
    shell_print(shell, "");
    
    return 0;
}

/**
 * OPT3006 read command - read current illuminance
 */
static int cmd_opt3006_read(const struct shell *shell, size_t argc, char **argv)
{
    float lux;
    uint16_t raw;
    uint8_t exp;
    uint16_t mant;
    int ret;
    
    // Read lux with raw data
    ret = opt3006_read_lux_ex(&lux, &raw, &exp, &mant);
    if (ret != 0)
    {
        shell_error(shell, "Failed to read illuminance: %d", ret);
        return ret;
    }
    
    shell_print(shell, "");
    shell_print(shell, "📊 Current Illuminance:");
    shell_print(shell, "  Lux:      %.2f lux", lux);
    shell_print(shell, "  Raw:      0x%04X", raw);
    shell_print(shell, "  Exponent: %d", exp);
    shell_print(shell, "  Mantissa: %d", mant);
    shell_print(shell, "");
    
    return 0;
}

/**
 * OPT3006 config command - show current configuration
 */
static int cmd_opt3006_config(const struct shell *shell, size_t argc, char **argv)
{
    uint16_t config;
    int ret;
    
    ret = opt3006_get_config(&config);
    if (ret != 0)
    {
        shell_error(shell, "Failed to read configuration: %d", ret);
        return ret;
    }
    
    uint8_t rn = (config >> OPT3006_CONFIG_RN_SHIFT) & 0x0F;
    uint8_t ct = (config >> OPT3006_CONFIG_CT_BIT) & 0x01;
    uint8_t mode = (config >> OPT3006_CONFIG_M_SHIFT) & 0x03;
    uint8_t ovf = (config >> OPT3006_CONFIG_OVF_BIT) & 0x01;
    uint8_t crf = (config >> OPT3006_CONFIG_CRF_BIT) & 0x01;
    uint8_t latch = (config >> OPT3006_CONFIG_L_BIT) & 0x01;
    
    shell_print(shell, "");
    shell_print(shell, "⚙️  OPT3006 Configuration Register: 0x%04X", config);
    shell_print(shell, "=========================================");
    shell_print(shell, "Range Number (RN):    0x%X (%s)", rn, rn == 0x0C ? "AUTO" : "Manual");
    shell_print(shell, "Conversion Time (CT): %d (%s)", ct, ct ? "800ms" : "100ms");
    shell_print(shell, "Mode (M):             %d (%s)", mode,
                mode == 0 ? "Shutdown" :
                mode == 1 ? "Single-shot" : "Continuous");
    shell_print(shell, "Overflow Flag (OVF):  %d", ovf);
    shell_print(shell, "Conv Ready (CRF):     %d", crf);
    shell_print(shell, "Latch Mode (L):       %d (%s)", latch, latch ? "Latched" : "Transparent");
    shell_print(shell, "=========================================");
    shell_print(shell, "");
    
    return 0;
}

/**
 * OPT3006 mode command - set conversion mode
 */
static int cmd_opt3006_mode(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_error(shell, "Usage: opt3006 mode <continuous|single|shutdown>");
        return -EINVAL;
    }
    
    uint8_t mode;
    const char *mode_str = argv[1];
    
    if (strcmp(mode_str, "continuous") == 0)
    {
        mode = OPT3006_MODE_CONTINUOUS;
    }
    else if (strcmp(mode_str, "single") == 0)
    {
        mode = OPT3006_MODE_SINGLE_SHOT;
    }
    else if (strcmp(mode_str, "shutdown") == 0)
    {
        mode = OPT3006_MODE_SHUTDOWN;
    }
    else
    {
        shell_error(shell, "Invalid mode: %s", mode_str);
        shell_error(shell, "Valid modes: continuous, single, shutdown");
        return -EINVAL;
    }
    
    int ret = opt3006_set_mode(mode);
    if (ret != 0)
    {
        shell_error(shell, "Failed to set mode: %d", ret);
        return ret;
    }
    
    shell_print(shell, "✓ Mode set to: %s", mode_str);
    return 0;
}

/**
 * OPT3006 ct command - set conversion time
 */
static int cmd_opt3006_ct(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_error(shell, "Usage: opt3006 ct <100|800>");
        return -EINVAL;
    }
    
    int ct_ms = atoi(argv[1]);
    uint8_t ct;
    
    if (ct_ms == 100)
    {
        ct = OPT3006_CT_100MS;
    }
    else if (ct_ms == 800)
    {
        ct = OPT3006_CT_800MS;
    }
    else
    {
        shell_error(shell, "Invalid conversion time: %d", ct_ms);
        shell_error(shell, "Valid times: 100, 800");
        return -EINVAL;
    }
    
    int ret = opt3006_set_conversion_time(ct);
    if (ret != 0)
    {
        shell_error(shell, "Failed to set conversion time: %d", ret);
        return ret;
    }
    
    shell_print(shell, "✓ Conversion time set to: %d ms", ct_ms);
    return 0;
}

/**
 * OPT3006 test command - run continuous measurement test
 */
static int cmd_opt3006_test(const struct shell *shell, size_t argc, char **argv)
{
    uint32_t count = 100;  // Default: 100 samples
    
    if (argc >= 2)
    {
        count = atoi(argv[1]);
    }
    
    shell_print(shell, "");
    shell_print(shell, "🧪 Starting OPT3006 continuous measurement test");
    if (count == 0)
    {
        shell_print(shell, "   Mode: Infinite (press any key to stop)");
    }
    else
    {
        shell_print(shell, "   Samples: %d", count);
    }
    shell_print(shell, "   Interval: 1 second");
    shell_print(shell, "========================================");
    
    float lux;
    uint16_t raw;
    uint8_t exp;
    uint16_t mant;
    int ret;
    
    float lux_min = 999999.0f;
    float lux_max = 0.0f;
    float lux_sum = 0.0f;
    uint32_t sample_count = 0;
    uint32_t error_count = 0;
    
    // Infinite loop or limited count
    while (count == 0 || sample_count < count)
    {
        ret = opt3006_read_lux_ex(&lux, &raw, &exp, &mant);
        if (ret == 0)
        {
            sample_count++;
            lux_sum += lux;
            
            if (lux < lux_min) lux_min = lux;
            if (lux > lux_max) lux_max = lux;
            
            shell_print(shell, "[#%04d] Raw:0x%04x E:%d M:%d → %.2f lux (Min:%.2f Max:%.2f Avg:%.2f)",
                        sample_count, raw, exp, mant, lux, lux_min, lux_max, lux_sum / sample_count);
            
            // Every 10 samples, print summary
            if (sample_count % 10 == 0)
            {
                shell_print(shell, "---------------------------------------");
                shell_print(shell, "📊 Statistics [Samples: %d]", sample_count);
                shell_print(shell, "   Current: %.2f lux", lux);
                shell_print(shell, "   Min:     %.2f lux", lux_min);
                shell_print(shell, "   Max:     %.2f lux", lux_max);
                shell_print(shell, "   Average: %.2f lux", lux_sum / sample_count);
                shell_print(shell, "   Errors:  %d", error_count);
                shell_print(shell, "---------------------------------------");
            }
        }
        else
        {
            error_count++;
            shell_error(shell, "Failed to read lux (error #%d): %d", error_count, ret);
            
            if (error_count > 10)
            {
                shell_error(shell, "Too many errors, aborting test");
                break;
            }
        }
        
        // Sleep 1 second
        k_sleep(K_SECONDS(1));
    }
    
    // Final summary
    shell_print(shell, "");
    shell_print(shell, "========================================");
    shell_print(shell, "📊 Test Completed");
    shell_print(shell, "========================================");
    shell_print(shell, "Total samples: %d", sample_count);
    shell_print(shell, "Error count:   %d", error_count);
    if (sample_count > 0)
    {
        shell_print(shell, "Min lux:       %.2f", lux_min);
        shell_print(shell, "Max lux:       %.2f", lux_max);
        shell_print(shell, "Avg lux:       %.2f", lux_sum / sample_count);
        shell_print(shell, "Success rate:  %.1f%%", 
                    100.0f * sample_count / (sample_count + error_count));
    }
    shell_print(shell, "========================================");
    shell_print(shell, "");
    
    return (error_count > 10) ? -1 : 0;
}

/**
 * OPT3006 read_reg command - read specific register
 */
static int cmd_opt3006_read_reg(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_error(shell, "Usage: opt3006 read_reg <addr>");
        shell_error(shell, "Example: opt3006 read_reg 0x01");
        return -EINVAL;
    }
    
    // Parse register address (supports 0x prefix)
    uint32_t reg_addr = strtoul(argv[1], NULL, 0);
    if (reg_addr > 0x7F)
    {
        shell_error(shell, "Invalid register address: 0x%02X (must be 0x00-0x7F)", reg_addr);
        return -EINVAL;
    }
    
    uint16_t value;
    int ret = opt3006_read_reg((uint8_t)reg_addr, &value);
    if (ret != 0)
    {
        shell_error(shell, "Failed to read register 0x%02X: %d", reg_addr, ret);
        return ret;
    }
    
    shell_print(shell, "");
    shell_print(shell, "📖 Register Read:");
    shell_print(shell, "  Address: 0x%02X", reg_addr);
    shell_print(shell, "  Value:   0x%04X (decimal: %d)", value, value);
    shell_print(shell, "  Binary:  %04x %04x", (value >> 8) & 0xFF, value & 0xFF);
    
    // Parse known registers
    const char* reg_name = "Unknown";
    switch (reg_addr)
    {
        case 0x00: reg_name = "Result"; break;
        case 0x01: reg_name = "Configuration"; break;
        case 0x02: reg_name = "Low Limit"; break;
        case 0x03: reg_name = "High Limit"; break;
        case 0x7E: reg_name = "Manufacturer ID"; break;
        case 0x7F: reg_name = "Device ID"; break;
    }
    shell_print(shell, "  Name:    %s", reg_name);
    
    // Parse configuration register if addr is 0x01
    if (reg_addr == 0x01)
    {
        uint8_t rn = (value >> 12) & 0x0F;
        uint8_t ct = (value >> 11) & 0x01;
        uint8_t mode = (value >> 9) & 0x03;
        
        shell_print(shell, "  Parsed:");
        shell_print(shell, "    RN (15:12): 0x%X (%s)", rn, rn == 0x0C ? "AUTO" : "Manual");
        shell_print(shell, "    CT (11):    %d (%s)", ct, ct ? "800ms" : "100ms");
        shell_print(shell, "    M (10:9):   %d (%s)", mode,
                    mode == 0 ? "Shutdown" :
                    mode == 1 ? "Single" : "Continuous");
    }
    
    shell_print(shell, "");
    return 0;
}

/**
 * OPT3006 write_reg command - write specific register
 */
static int cmd_opt3006_write_reg(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 3)
    {
        shell_error(shell, "Usage: opt3006 write_reg <addr> <value>");
        shell_error(shell, "Example: opt3006 write_reg 0x01 0xCC10");
        return -EINVAL;
    }
    
    // Parse register address and value (supports 0x prefix)
    uint32_t reg_addr = strtoul(argv[1], NULL, 0);
    uint32_t value = strtoul(argv[2], NULL, 0);
    
    if (reg_addr > 0x7F)
    {
        shell_error(shell, "Invalid register address: 0x%02X (must be 0x00-0x7F)", reg_addr);
        return -EINVAL;
    }
    
    if (value > 0xFFFF)
    {
        shell_error(shell, "Invalid value: 0x%04X (must be 0x0000-0xFFFF)", value);
        return -EINVAL;
    }
    
    // Warn about read-only registers
    if (reg_addr == 0x00 || reg_addr == 0x7E || reg_addr == 0x7F)
    {
        shell_warn(shell, "⚠️  Register 0x%02X is read-only!", reg_addr);
        shell_warn(shell, "   Write operation may have no effect or fail.");
    }
    
    int ret = opt3006_write_reg((uint8_t)reg_addr, (uint16_t)value);
    if (ret != 0)
    {
        shell_error(shell, "Failed to write register 0x%02X: %d", reg_addr, ret);
        return ret;
    }
    
    shell_print(shell, "");
    shell_print(shell, "✓ Register Write Successful:");
    shell_print(shell, "  Address: 0x%02X", reg_addr);
    shell_print(shell, "  Value:   0x%04X", value);
    
    // Read back to verify
    uint16_t read_back;
    ret = opt3006_read_reg((uint8_t)reg_addr, &read_back);
    if (ret == 0)
    {
        shell_print(shell, "  Verified: 0x%04X %s", read_back,
                    read_back == value ? "✓" : "✗ Mismatch!");
        
        if (read_back != value)
        {
            shell_warn(shell, "⚠️  Read-back value differs from written value");
            shell_warn(shell, "   This is normal for read-only or flag bits");
        }
    }
    shell_print(shell, "");
    
    return 0;
}

/* Shell command definitions */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_opt3006,
    SHELL_CMD(help, NULL, "Show OPT3006 commands help", cmd_opt3006_help),
    SHELL_CMD(info, NULL, "Show sensor information", cmd_opt3006_info),
    SHELL_CMD(read, NULL, "Read current illuminance", cmd_opt3006_read),
    SHELL_CMD(config, NULL, "Show current configuration", cmd_opt3006_config),
    SHELL_CMD_ARG(mode, NULL, "Set mode: continuous|single|shutdown", cmd_opt3006_mode, 2, 0),
    SHELL_CMD_ARG(ct, NULL, "Set conversion time: 100|800", cmd_opt3006_ct, 2, 0),
    SHELL_CMD_ARG(test, NULL, "Run continuous test [count]", cmd_opt3006_test, 1, 1),
    SHELL_CMD_ARG(read_reg, NULL, "Read register: <addr>", cmd_opt3006_read_reg, 2, 0),
    SHELL_CMD_ARG(write_reg, NULL, "Write register: <addr> <value>", cmd_opt3006_write_reg, 3, 0),
    SHELL_SUBCMD_SET_END /* Array terminated. */
);

SHELL_CMD_REGISTER(opt3006, &sub_opt3006, "OPT3006 ambient light sensor control", cmd_opt3006_help);

