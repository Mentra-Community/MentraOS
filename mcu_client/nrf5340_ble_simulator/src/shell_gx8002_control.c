/*
 * Shell GX8002 Control Module
 * 
 * GX8002 test commands for nRF5340 BLE Simulator
 * 
 * Available Commands:
 * - gx8002 help                    : Show all gx8002 commands
 * - gx8002 version                 : Get GX8002 firmware version
 * - gx8002 handshake               : Test I2C handshake with GX8002
 * - gx8002 reset                   : Reset GX8002 chip
 * 
 * Created: 2025-12-03
 * Author: MentraOS Team
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include <errno.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include "bsp_gx8002.h"
#include "gx8002_update.h"
#include "gx8002_firmware_data.h"
#include "bspal_audio_i2s.h"

typedef struct
{
    const char* name;
    const uint8_t* data;
    uint32_t len;
} firmware_entry_t;


static firmware_entry_t firmware_table[2]; 
static size_t firmware_table_size = 0;


static void init_firmware_table(void)
{
    if (firmware_table_size > 0)
    {
        return;  // 已经初始化
    }
    
    firmware_table[0].name = "v07";
    firmware_table[0].data = gx8002_firmware_data_07;
    firmware_table[0].len = gx8002_firmware_data_07_len;
    
    firmware_table[1].name = "v08";
    firmware_table[1].data = gx8002_firmware_data_08;
    firmware_table[1].len = gx8002_firmware_data_08_len;
    
    firmware_table_size = 2;
}

#define FIRMWARE_TABLE_SIZE_MAX 10  // 最大固件数量

LOG_MODULE_REGISTER(shell_gx8002, LOG_LEVEL_INF);

/**
 * GX8002 help command
 */
static int cmd_gx8002_help(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "🎤 GX8002 Control Commands:");
    shell_print(shell, "");
    shell_print(shell, "📋 Available Commands:");
    shell_print(shell, "  gx8002 help                     - Show this help menu");
    shell_print(shell, "  gx8002 version                  - Get GX8002 firmware version");
    shell_print(shell, "  gx8002 reset                    - Reset GX8002 chip (power cycle via P0.04)");
    shell_print(shell, "  gx8002 handshake                - Test I2C handshake with GX8002");
    shell_print(shell, "  gx8002 start_i2s                - Start GX8002 I2S audio output (master mode)");
    shell_print(shell, "  gx8002 enable_i2s               - Enable GX8002 I2S output (write 0x71 to 0xC4)");
    shell_print(shell, "  gx8002 disable_i2s              - Disable GX8002 I2S output (write 0x72 to 0xC4)");
    shell_print(shell, "  gx8002 mic_state                - Get GX8002 microphone (VAD) state");
    shell_print(shell, "  gx8002 update [firmware_name]   - Start firmware OTA update");
    shell_print(shell, "");
    shell_print(shell, "📦 Available Firmware:");
    init_firmware_table();
    for (size_t i = 0; i < firmware_table_size; i++)
    {
        shell_print(shell, "  - %s (%u bytes)", firmware_table[i].name, firmware_table[i].len);
    }
    shell_print(shell, "");
    
    return 0;
}

/**
 * Get GX8002 version command
 */
static int cmd_gx8002_version(const struct shell *shell, size_t argc, char **argv)
{
    int ret = bsp_gx8002_init();
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to initialize GX8002: %d", ret);
        shell_print(shell, "💡 Check i2c1 node in device tree");
        return ret;
    }

    uint8_t version[4] = {0};
    
    shell_print(shell, "🔍 Reading GX8002 firmware version...");
    
    if (bsp_gx8002_getversion(version))
    {
        shell_print(shell, "✅ GX8002 Version: %d.%d.%d.%d", 
                   version[0], version[1], version[2], version[3]);
        return 0;
    }
    else
    {
        shell_error(shell, "❌ Failed to read GX8002 version");
        return -EIO;
    }
}

/**
 * Reset command - Power cycle GX8002 using P0.04 GPIO
 */
static int cmd_gx8002_reset(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "🔄 Resetting GX8002...");
    
    bsp_gx8002_reset();
    
    shell_print(shell, "✅ GX8002 reset completed");
    
    return 0;
}

/**
 * Handshake command
 */
static int cmd_gx8002_handshake(const struct shell *shell, size_t argc, char **argv)
{
    int ret = bsp_gx8002_init();
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to initialize GX8002: %d", ret);
        shell_print(shell, "💡 Check i2c1 node in device tree");
        return ret;
    }

    shell_print(shell, "🤝 Testing GX8002 handshake...");
    bsp_gx8002_reset();
    k_sleep(K_MSEC(10));
    if (bsp_gx8002_handshake())
    {
        shell_print(shell, "✅ Handshake successful!");
        return 0;
    }
    else
    {
        shell_error(shell, "❌ Handshake failed");
        shell_print(shell, "💡 Check:");
        shell_print(shell, "   - I2C connection (SDA/SCL)");
        shell_print(shell, "   - GX8002 power supply");
        shell_print(shell, "   - I2C address (should be 0x35 or 0x36)");
        return -EIO;
    }
}

/**
 * Start I2S command - Start GX8002 I2S audio output
 * Usage: gx8002 start_i2s
 */
static int cmd_gx8002_start_i2s(const struct shell *shell, size_t argc, char **argv)
{
    int ret = bsp_gx8002_init();
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to initialize GX8002: %d", ret);
        shell_print(shell, "💡 Check i2c1 node in device tree");
        return ret;
    }

    shell_print(shell, "🎵 Starting GX8002 I2S audio output...");
    shell_print(shell, "");
    shell_print(shell, "💡 This will configure GX8002 as I2S master");
    shell_print(shell, "💡 GX8002 will send clock signals (SCK, LRCK) to nRF5340");
    shell_print(shell, "");
    
    if (bsp_gx8002_start_i2s())
    {
        shell_print(shell, "");
        shell_print(shell, "✅ GX8002 I2S output started successfully!");
        shell_print(shell, "💡 GX8002 should now be sending I2S clocks and audio data");
        shell_print(shell, "💡 Check I2S pins: SCK, LRCK, SDIN should have signals");
        shell_print(shell, "💡 nRF5340 (I2S slave) should now receive data");
        return 0;
    }
    else
    {
        shell_error(shell, "");
        shell_error(shell, "❌ Failed to start GX8002 I2S output!");
        shell_print(shell, "💡 Check GX8002 connection and I2C communication");
        return -EIO;
    }
}

/**
 * Enable I2S command - Enable GX8002 I2S output
 * Usage: gx8002 enable_i2s
 * 
 * This command will:
 * 1. Enable I2S output by writing 0x71 to register 0xC4 at address 0x2F
 * 2. Start nRF5340 I2S slave reception to receive data from GX8002
 * 
 * Note: According to documentation, writing the enable command via I2C will
 *       start I2S data output immediately, no reset needed.
 */
static int cmd_gx8002_enable_i2s(const struct shell *shell, size_t argc, char **argv)
{
    int ret = bsp_gx8002_init();
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to initialize GX8002: %d", ret);
        shell_print(shell, "💡 Check i2c1 node in device tree");
        return ret;
    }

    shell_print(shell, "🎵 Enabling GX8002 I2S output...");
    shell_print(shell, "");
    shell_print(shell, "Step 1: Enabling I2S output (write 0x71 to 0xC4 at 0x2F)...");
    
    // Step 1: Enable I2S output by writing 0x71 to register 0xC4
    uint8_t enable_result = bsp_gx8002_enable_i2s();
    if (!enable_result)
    {
        shell_error(shell, "❌ Failed to enable GX8002 I2S output!");
        shell_print(shell, "💡 Check GX8002 connection and I2C communication");
        shell_print(shell, "💡 Try: gx8002 reset, then gx8002 enable_i2s again");
        return -EIO;
    }
    
    shell_print(shell, "Step 2: Checking nRF5340 I2S status...");
    
    // Step 2: I2S will be started automatically by pdm_audio_stream when audio is enabled
    // We don't start I2S here to avoid blocking - let the audio system handle it
    // The audio system will start I2S when pdm_audio_stream_set_enabled(true) is called
    
    shell_print(shell, "");
    shell_print(shell, "✅ GX8002 I2S output enabled successfully!");
    shell_print(shell, "💡 Note: nRF5340 I2S slave will start automatically when audio system is enabled");
    shell_print(shell, "💡 I2S data will be sent to phone only when:");
    shell_print(shell, "   - I2S is enabled (✅ done)");
    shell_print(shell, "   - BLE is connected");
    shell_print(shell, "");
    shell_print(shell, "💡 According to documentation, I2S data should now be available");
    shell_print(shell, "💡 GX8002 should now be sending:");
    shell_print(shell, "   - SCK (Bit Clock)");
    shell_print(shell, "   - LRCK (Frame Clock)");
    shell_print(shell, "   - SDIN (Serial Data)");
    shell_print(shell, "");
    shell_print(shell, "💡 If I2S timeout warnings persist, check:");
    shell_print(shell, "   - I2S pin connections (SCK, LRCK, SDIN)");
    shell_print(shell, "   - GX8002 power supply");
    shell_print(shell, "   - GX8002 firmware version");
    return 0;
}

/**
 * Disable I2S command - Disable GX8002 I2S output and stop nRF5340 I2S reception
 * Usage: gx8002 disable_i2s
 * 
 * This command will:
 * 1. Disable GX8002 I2S output (write 0x72 to register 0xC4 at address 0x2F)
 * 2. Stop nRF5340 I2S slave reception to prevent timeout warnings
 */
static int cmd_gx8002_disable_i2s(const struct shell *shell, size_t argc, char **argv)
{
    int ret = bsp_gx8002_init();
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to initialize GX8002: %d", ret);
        shell_print(shell, "💡 Check i2c1 node in device tree");
        return ret;
    }

    shell_print(shell, "🔇 Disabling GX8002 I2S output...");
    shell_print(shell, "");
    shell_print(shell, "Step 1: Disabling GX8002 I2S output (write 0x72 to 0xC4 at 0x2F)...");
    
    // Step 1: Disable GX8002 I2S output
    if (bsp_gx8002_disable_i2s())
    {
    shell_print(shell, "Step 2: Note about nRF5340 I2S...");
    
    // Step 2: I2S will be stopped automatically by pdm_audio_stream when audio is disabled
    // We don't stop I2S here directly - let the audio system handle it
    // The audio system will stop I2S when pdm_audio_stream_set_enabled(false) is called
    
    shell_print(shell, "");
    shell_print(shell, "✅ GX8002 I2S output disabled successfully!");
    shell_print(shell, "💡 Note: nRF5340 I2S slave will be stopped by audio system when needed");
    shell_print(shell, "");
    shell_print(shell, "💡 I2S data will no longer be sent to phone (I2S disabled)");
        return 0;
    }
    else
    {
        shell_error(shell, "❌ Failed to disable GX8002 I2S output!");
        shell_print(shell, "💡 Check GX8002 connection and I2C communication");
        return -EIO;
    }
}

/**
 * Get microphone state command - Get GX8002 VAD state
 * Usage: gx8002 mic_state
 */
static int cmd_gx8002_mic_state(const struct shell *shell, size_t argc, char **argv)
{
    int ret = bsp_gx8002_init();
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to initialize GX8002: %d", ret);
        shell_print(shell, "💡 Check i2c1 node in device tree");
        return ret;
    }

    shell_print(shell, "🎤 Getting GX8002 microphone (VAD) state...");
    shell_print(shell, "💡 Writing 0x70 to register 0xC4, then reading register 0xA0");
    shell_print(shell, "");
    
    uint8_t state = 0;
    if (bsp_gx8002_get_mic_state(&state))
    {
        shell_print(shell, "");
        shell_print(shell, "📊 VAD State Result:");
        shell_print(shell, "   Register 0xA0 value: %d", state);
        
        if (state == 0)
        {
            shell_print(shell, "   Status: ❌ 异常 (异常)");
        }
        else if (state == 1)
        {
            shell_print(shell, "   Status: ✅ 正常 (Normal)");
        }
        else
        {
            shell_print(shell, "   Status: ⚠️  未知 (Unknown value: %d)", state);
        }
        
        shell_print(shell, "");
        return 0;
    }
    else
    {
        shell_error(shell, "");
        shell_error(shell, "❌ Failed to get GX8002 microphone state!");
        shell_print(shell, "💡 Check GX8002 connection and I2C communication");
        return -EIO;
    }
}

/**
 * Update command - Start GX8002 firmware OTA update
 * Usage: gx8002 update [firmware_name]
 */
static int cmd_gx8002_update(const struct shell *shell, size_t argc, char **argv)
{
    int ret = bsp_gx8002_init();
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to initialize GX8002: %d", ret);
        shell_print(shell, "💡 Check i2c1 node in device tree");
        return ret;
    }

    const uint8_t* firmware_data = NULL;
    uint32_t firmware_len = 0;
    const char* firmware_name = "v07";  

    init_firmware_table();
    if (argc > 1)
    {
        firmware_name = argv[1];
        bool found = false;
        for (size_t i = 0; i < firmware_table_size; i++)
        {
            if (strcmp(firmware_table[i].name, firmware_name) == 0)
            {
                firmware_data = firmware_table[i].data;
                firmware_len = firmware_table[i].len;
                found = true;
                break;
            }
        }
        
        if (!found)
        {
            shell_error(shell, "❌ Firmware '%s' not found!", firmware_name);
            shell_print(shell, "");
            shell_print(shell, "📦 Available firmware:");
            for (size_t i = 0; i < firmware_table_size; i++)
            {
                shell_print(shell, "  - %s", firmware_table[i].name);
            }
            return -EINVAL;
        }
    }
    else
    {
        firmware_data = firmware_table[0].data;
        firmware_len = firmware_table[0].len;
        firmware_name = firmware_table[0].name; 
    }

    shell_print(shell, "🚀 Starting GX8002 firmware OTA update...");
    shell_print(shell, "📦 Firmware: %s (%u bytes)", firmware_name, firmware_len);
    shell_print(shell, "");
    shell_print(shell, "⚠️  This process may take several minutes");
    shell_print(shell, "⚠️  Do not power off or reset during update!");
    shell_print(shell, "");
    
    if (gx8002_fw_update(firmware_data, firmware_len))
    {
        shell_print(shell, "");
        shell_print(shell, "✅ Firmware update completed successfully!");
        shell_print(shell, "💡 Please reset the device to apply the new firmware");
        return 0;
    }
    else
    {
        shell_error(shell, "");
        shell_error(shell, "❌ Firmware update failed!");
        shell_print(shell, "💡 Check logs for detailed error information");
        return -EIO;
    }
}

/* Shell command definitions */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_gx8002,
    SHELL_CMD(help, NULL, "Show gx8002 commands help", cmd_gx8002_help),
    SHELL_CMD(version, NULL, "Get GX8002 firmware version", cmd_gx8002_version),
    SHELL_CMD(reset, NULL, "Reset GX8002 chip (power cycle via P0.04)", cmd_gx8002_reset),
    SHELL_CMD(handshake, NULL, "Test I2C handshake with GX8002", cmd_gx8002_handshake),
    SHELL_CMD(start_i2s, NULL, "Start GX8002 I2S audio output (master mode)", cmd_gx8002_start_i2s),
    SHELL_CMD(enable_i2s, NULL, "Enable GX8002 I2S output (write 0x71 to 0xC4)", cmd_gx8002_enable_i2s),
    SHELL_CMD(disable_i2s, NULL, "Disable GX8002 I2S output (write 0x72 to 0xC4)", cmd_gx8002_disable_i2s),
    SHELL_CMD(mic_state, NULL, "Get GX8002 microphone (VAD) state", cmd_gx8002_mic_state),
    SHELL_CMD_ARG(update, NULL, "Start firmware OTA update [firmware_name]", cmd_gx8002_update, 1, 1),
    SHELL_SUBCMD_SET_END /* Array terminated. */
);

SHELL_CMD_REGISTER(gx8002, &sub_gx8002, "GX8002 control commands", cmd_gx8002_help);
