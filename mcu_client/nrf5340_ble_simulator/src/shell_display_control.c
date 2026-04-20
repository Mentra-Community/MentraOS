/*
 * Shell Display Control Module
 *
 * Manual display control commands for nRF5340 BLE Simulator
 * Supporting both A6N projector and SSD1306 OLED displays
 *
 * Available Commands:
 * - display help                    : Show all display commands
 * - display brightness <0-100>      : Set display brightness
 * - display clear                   : Clear display
 * - display text "string" <x> <y> <size> : Write text at position with font size
 * - display info                    : Show display information
 *
 * Created: 2025-09-30
 * Author: MentraOS Team
 */

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>
#include <zephyr/storage/flash_map.h>
#include <zephyr/sys/byteorder.h>

// Include LVGL for text rendering
#include <lvgl.h>

// Include A6N driver for brightness control
#include "../custom_driver_module/drivers/display/lcd/a6n.h"

// Include MOS LVGL display functions
#include <pm_config.h>

#include "mos_binfont_lvgl.h"
#include "mos_lvgl_display.h"

// Include protobuf handler for battery functions
#include "protobuf_handler.h"
// Brightness component (AUTO + manual state)
#include "mos_brightness.h"
// A6N driver API for register read/write
#include "../custom_driver_module/drivers/display/lcd/a6n.h"

// External declaration for LVGL display message queue
extern struct k_msgq lvgl_display_msgq;

LOG_MODULE_REGISTER(shell_display, LOG_LEVEL_INF);

#ifndef PM_QSPI_NOR_BASE_ADDRESS
#define PM_QSPI_NOR_BASE_ADDRESS 0x10000000u
#endif
#define FONT_STORAGE_XIP_ADDR (PM_QSPI_NOR_BASE_ADDRESS + PM_FONT_STORAGE_ADDRESS)

// Helper function to map font sizes to available fonts - project uses 18pt only
static const lv_font_t *get_font_by_size(int size)
{
    (void)size;
    return &lv_font_montserrat_18;
}

/**
 * Display help command
 */
static int cmd_display_help(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "🖥️  Display Control Commands:");
    shell_print(shell, "");
    shell_print(shell, "📋 Basic Commands:");
    shell_print(shell, "  display help                     - Show this help menu");
    shell_print(shell, "  display info                     - Show display information");
    shell_print(shell, "  display clear                    - Clear entire display (black)");
    shell_print(shell, "  display fill                     - Fill entire display (white)");
    shell_print(shell, "");
    shell_print(shell, "🔆 Brightness Control:");
    shell_print(shell, "  display brightness <0-100>      - Set display brightness (linear 0-100%%)");
    shell_print(shell, "  display brightness auto status  - Show AUTO brightness status");
    shell_print(shell, "  display brightness auto on      - Enable AUTO brightness");
    shell_print(shell, "  display brightness auto off     - Disable AUTO brightness");
    shell_print(shell, "  display brightness auto log on  - Enable AUTO sample log");
    shell_print(shell, "  display brightness auto log off - Disable AUTO sample log");
    shell_print(shell, "  display brightness auto multiplier <value> - Set AUTO multiplier (0.10-3.00)");
    shell_print(shell, "");
    shell_print(shell, "🎨 Pattern Control:");
    shell_print(shell, "  display pattern <0-5>            - Select specific pattern:");
    shell_print(shell, "    • 0: Chess pattern");
    shell_print(shell, "    • 1: Horizontal zebra");
    shell_print(shell, "    • 2: Vertical zebra");
    shell_print(shell, "    • 3: Scrolling welcome text");
    shell_print(shell, "    • 4: Protobuf text container (default)");
    shell_print(shell, "    • 5: XY text positioning area");
    shell_print(shell, "");
    shell_print(shell, "✏️  Text Commands:");
    shell_print(shell, "  display text \"Hello\"              - Text overlay (center position, for patterns)");
    shell_print(shell, "  display text \"Hello\" <x> <y> <size> - Write text at specific position");
    shell_print(shell, "  display b_t                      - Show binfont test text");
    shell_print(shell, "  display cjk_hex <hex> [x] [y]     - Show UTF-8 text from hex bytes");
    shell_print(shell, "");
    shell_print(shell, "📐 Layout Control:");
    shell_print(shell, "  display layout margin <pixels>     - Set container margin (current: margin from edges)");
    shell_print(shell, "  display layout padding <pixels>    - Set container padding (current: internal padding)");
    shell_print(shell, "  display layout position <x> <y>    - Move container position");
    shell_print(shell, "  display layout size <width> <height> - Set container size");
    shell_print(shell, "  display layout info               - Show current layout settings");
    shell_print(shell, "  display layout reset              - Reset to default layout");
    shell_print(shell, "");
    shell_print(shell, "🎨 Font Testing:");
    shell_print(shell, "  display fonts list               - Show all available font sizes");
    shell_print(shell, "  display fonts test               - Test all font sizes with sample text");
    shell_print(shell, "");
    shell_print(shell, "🔋 Battery Control:");
    shell_print(shell, "  display battery <level> [charging] - Set battery level and charging state");
    shell_print(shell, "    • level: 0-100 (percentage)");
    shell_print(shell, "    • charging: true/false (optional, default: false)");
    shell_print(shell, "");
    shell_print(shell, "Examples:");
    shell_print(shell, "  display brightness 50            - Set brightness to 50%%");
    shell_print(shell, "  display brightness auto status   - Show AUTO brightness status");
    shell_print(shell, "  display brightness auto on       - Enable ambient-light AUTO mode");
    shell_print(shell, "  display brightness auto log on   - Print AUTO sample log");
    shell_print(shell, "  display brightness auto multiplier 1.20 - Increase AUTO sensitivity");
    shell_print(shell, "  display brightness auto off      - Restore manual brightness");
    shell_print(shell, "  display pattern 2                - Show vertical zebra pattern");
    shell_print(shell, "  display battery 65               - Set 65%% battery, not charging");
    shell_print(shell, "  display battery 85 true          - Set 85%% battery, charging");
    shell_print(shell, "  display text \"Pattern 3\"          - Overlay text on current pattern");
    shell_print(shell, "  display text \"MentraOS\" 10 20 14  - Write 'MentraOS' at (10,20) with size 14");
    shell_print(shell, "  display b_t                      - Show binfont test text");
    shell_print(shell, "  display cjk_hex E6B58BE8AF95E4B8ADE69687  - UTF-8 hex text test at (10,10)");
    shell_print(shell, "  display depth 2                 - One-param depth (near/far)");
    shell_print(shell, "  display stereo 10 6              - Stereo depth demo (L+, R-)");
    shell_print(shell, "  display clear                    - Clear the screen");
    shell_print(shell, "  display fill                     - Fill screen with white");
    shell_print(shell, "");
    shell_print(shell, "🧩 A6N Register Access:");
    shell_print(shell, "  display read <addr> [mode]       - Read A6N register");
    shell_print(shell, "  display write <addr> <value>     - Write A6N register");
    shell_print(shell, "  display depth <offset>           - Software depth offset (pixel disparity)");
    shell_print(shell, "                                   - offset: -16..16, pure software (no shift register write)");
    shell_print(shell, "  display redraw                   - Full-screen invalidate + refresh");
    shell_print(shell, "  display redraw_visible            - Current pattern UI only (lighter than redraw)");
    shell_print(shell, "  display distance <meters>        - Distance control by trigonometry (2.0-5.0m)");
    shell_print(shell, "                                   - default: 2.5m => 0px, values clamp to 2.0-5.0m");
    shell_print(shell, "  display distance_test            - Print 2.0-5.0m distance-to-pixel table");
    shell_print(shell, "  display stereo <lh> <rh>         - Hardware stereo shift (register)");
    shell_print(shell, "                                   - lh/rh: left/right H shift only");
    shell_print(shell, "                                   - mirror is preserved from existing panel setting");
    shell_print(shell, "");
    shell_print(shell, "🌡️  Temperature Control:");
    shell_print(shell, "  display get_temp                  - Read A6N panel temperature (°C)");
    shell_print(shell, "  display min_temp_limit set <°C>   - Set low temperature recovery threshold");
    shell_print(shell, "  display min_temp_limit get        - Get low temperature recovery threshold");
    shell_print(shell, "  display max_temp_limit set <°C>   - Set high temperature protection threshold");
    shell_print(shell, "  display max_temp_limit get        - Get high temperature protection threshold");
    shell_print(shell, "");
    shell_print(shell, "📋 Parameters:");
    shell_print(shell, "  addr: 8-bit hex register address (0x00-0xFF)");
    shell_print(shell, "        Common:0xE2(brightness)");
    shell_print(shell, "  value: 8-bit hex value (0x00-0xFF)");
    shell_print(shell, "  mode: engine selection for read command only");
    shell_print(shell, "        0 = left optical engine (default)");
    shell_print(shell, "        1 = right optical engine");
    shell_print(shell, "  °C: temperature value in Celsius (not register value)");
    shell_print(shell, "      Valid range: -30°C to +70°C (per A6N spec)");
    shell_print(shell, "      Hardware registers: 0xF7 (high), 0xF8 (low)");
    shell_print(shell, "");
    shell_print(shell, "🏦 Bank Selection:");
    shell_print(shell, "  Bank0: default (most registers)");
    shell_print(shell, "  Bank1: use 'bank1:' prefix (e.g. bank1:0x55 for Demura control)");
    shell_print(shell, "");
    shell_print(shell, "💡 Register Examples:");
    shell_print(shell, "  display read 0xBE                - Read display mode");
    shell_print(shell, "  display read 0xBE 1              - Read from right engine");
    shell_print(shell, "  display write 0xBE 0x84          - Set GRAY16 mode");
    shell_print(shell, "  display read bank1:0x55          - Read Bank1 register");
    shell_print(shell, "  display write bank1:0x55 0x00    - Write Bank1 register");
    shell_print(shell, "");
    shell_print(shell, "🌡️  Temperature Examples:");
    shell_print(shell, "  display get_temp                 - Read current temperature & thresholds");
    shell_print(shell, "  display min_temp_limit set 0     - Set low recovery to 0°C");
    shell_print(shell, "  display min_temp_limit set -10   - Set low recovery to -10°C");
    shell_print(shell, "  display max_temp_limit set 65    - Set high protection to 65°C");
    shell_print(shell, "  display max_temp_limit get       - Read current high protection threshold");
    shell_print(shell, "");

    return 0;
}

/**
 * Display info command
 */
static int cmd_display_info(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "🖥️  Display Information:");
    shell_print(shell, "");
    shell_print(shell, "📱 System: MentraOS nRF5340 BLE Simulator");
    shell_print(shell, "📏 A6N Resolution: 640x480 pixels");
    shell_print(shell, "📏 SSD1306 Resolution: 128x64 pixels");
    shell_print(shell, "🎨 Pixel Format: MONO (1-bit)");
    shell_print(shell, "🔆 Brightness Support: Yes (A6N)");
    shell_print(shell, "� Available Fonts: 12px, 14px");
    shell_print(shell, "");

    return 0;
}

/**
 * Display brightness command
 */
/**
 * @brief 设置显示亮度 | Set display brightness
 *
 * 根据A6N手册6.4节 | Per A6N manual section 6.4:
 * - 最大值为0xE2寄存器默认值（上电后读取）| Max value is 0xE2 register default (read after power-on)
 * - 相邻等级差值最小为2 | Minimum difference between adjacent levels is 2
 * - 最多支持64级亮度可调 | Up to 64 brightness levels supported
 *
 * Shell命令将0-100%映射到实际寄存器值 | Shell command maps 0-100% to actual register value
 */
/**
 * @brief 设置显示亮度 (5档位) | Set display brightness (5 levels)
 *
 * 支持的亮度档位 | Supported brightness levels:
 * - 20%  (0x33)
 * - 40%  (0x66)
 * - 60%  (0x99)
 * - 80%  (0xCC)
 * - 100% (0xFF)
 */
static int cmd_display_brightness(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_error(shell, "❌ Usage: display brightness <0-100>");
        shell_print(shell, "");
        shell_print(shell, "亮度范围 | Brightness Range:");
        shell_print(shell, "  0   - Minimum brightness (0%%)");
        shell_print(shell, "  50  - Medium brightness (50%%)");
        shell_print(shell, "  100 - Maximum brightness (100%%)");
        shell_print(shell, "");
        shell_print(shell, "Examples:");
        shell_print(shell, "  display brightness 0    - Set to 0%%");
        shell_print(shell, "  display brightness 25   - Set to 25%%");
        shell_print(shell, "  display brightness 75   - Set to 75%%");
        shell_print(shell, "  display brightness 100  - Set to 100%%");
        return -EINVAL;
    }

    char *endptr = NULL;
    long brightness_pct = strtol(argv[1], &endptr, 10);

    if ((endptr == argv[1]) || (*endptr != '\0'))
    {
        shell_error(shell, "❌ Invalid brightness value: %s", argv[1]);
        shell_print(shell, "Usage: display brightness <0-100>");
        shell_print(shell, "AUTO:  display brightness auto <status|on|off|multiplier>");
        return -EINVAL;
    }

    // Validate brightness range
    if (brightness_pct < 0 || brightness_pct > 100)
    {
        shell_error(shell, "❌ Invalid brightness. Use value between 0-100");
        return -EINVAL;
    }

    // Set brightness through the state machine (also disables AUTO brightness)
    mos_brightness_request_manual((uint32_t)brightness_pct);
    shell_print(shell, "✅ Brightness set to %ld%% (AUTO disabled)", brightness_pct);
    LOG_INF("Display brightness set to %ld%% via shell", brightness_pct);
    return 0;
}

/**
 * Display clear command
 */
static int cmd_display_clear(const struct shell *shell, size_t argc, char **argv)
{
    // Use A6N driver's clear screen function
    // color_on = false means clear to black (background color)
    int ret = a6n_clear_screen(false);

    if (ret == 0)
    {
        shell_print(shell, "✅ Display cleared to black");
        LOG_INF("Display cleared via shell command using a6n_clear_screen()");
    }
    else
    {
        shell_error(shell, "❌ Failed to clear display (error: %d)", ret);
        LOG_ERR("Failed to clear display: %d", ret);
    }

    return ret;
}

/**
 * Display text command - supports both full parameters and text-only for pattern overlays
 */
static int cmd_display_text(const struct shell *shell, size_t argc, char **argv)
{
    const char *text;
    int x, y, size;
    if (argc == 2)
    {
        text = argv[1];
        x = 320;  // Center X for 640px width
        y = 240;  // Center Y for 480px height
        size = 14;  // Default font size
        shell_print(shell, "📝 Text overlay mode - using center position (320,240) with 14px font");
    }
    else if (argc == 5)
    {
        // Full parameter mode
        text = argv[1];
        x = atoi(argv[2]);
        y = atoi(argv[3]);
        size = atoi(argv[4]);
    }
    else
    {
        shell_error(shell, "❌ Usage:");
        shell_print(shell, "  display text \"string\"                    - Text overlay (center position)");
        shell_print(shell, "  display text \"string\" <x> <y> <size>      - Full control");
        shell_print(shell, "Examples:");
        shell_print(shell, "  display text \"Test Pattern 3\"           - Overlay on current pattern");
        shell_print(shell, "  display text \"Hello\" 10 20 14           - Specific position");
        return -EINVAL;
    }

    // Remove quotes from text if present
    static char clean_text[256];  // Make static to avoid stack issues
    if (text[0] == '"' && text[strlen(text) - 1] == '"')
    {
        strncpy(clean_text, text + 1, sizeof(clean_text) - 1);
        clean_text[strlen(text) - 2] = '\0';
        text = clean_text;
    }

    // Validate position (basic bounds for both displays)
    if (x < 0 || x > 640 || y < 0 || y > 480)
    {
        shell_error(shell, "❌ Position (%d,%d) outside reasonable bounds (0,0)-(640,480)", x, y);
        return -EINVAL;
    }

    // Validate font size - use available fonts (12, 14, 48) - 30pt commented out
    if (size != 12 && size != 14 && size != 48)
    {
        shell_print(shell, "⚠️  Font size %d not available, using 14px", size);
        shell_print(shell, "Available sizes: 12, 14, 48");
        size = 14;
    }

    // Use the same API as protobuf handler - display_update_xy_text
    // White color (0xFFFF in RGB565 format)
    display_update_xy_text(x, y, text, size, 0xFFFF);

    shell_print(shell, "✅ Text \"%s\" written at (%d,%d) with font %dpx", text, x, y, size);
    LOG_INF("Text displayed: \"%s\" at (%d,%d) size %d", text, x, y, size);

    return 0;
}

/**
 * Display binfont test command - renders a fixed Unicode string
 */
static int cmd_display_binfont_test(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argv);

    if (argc != 1)
    {
        shell_error(shell, "❌ Usage:");
        shell_print(shell, "  display b_t                - Show binfont test text");
        return -EINVAL;
    }

    /* 强制使用 UTF-8 字节序列，避免源文件编码导致乱码 */
    const char *text = "\xE4\xBD\xA0\xE5\xA5\xBD, MentraOS";
    int x = 10;
    int y = 10;

    /* 字体大小由 binfont 自身决定，这里传 0 表示不指定尺寸 */
    /* Binfont size is determined by the font itself, passing 0 means no specific size */
    /* 强制重新加载 binfont，确保使用刚烧录的新字库 */
    mos_binfont_lvgl_deinit();
    display_update_xy_text((uint16_t)x, (uint16_t)y, text, 0, 0xFFFF);
    shell_print(shell, "✅ Binfont test text written at (%d,%d)", x, y);

    return 0;
}

/* 将十六进制字符串解析为 UTF-8 字节写入 buf，返回写入字节数，-1 表示错误 */
static int hex_string_to_utf8(const char *hex, uint8_t *buf, size_t buf_size)
{
    size_t out = 0;
    for (; *hex && out < buf_size;)
    {
        while (*hex == ' ' || *hex == '\t')
            hex++;
        if (!*hex)
            break;
        int hi = -1, lo = -1;
        char c = *hex++;
        if (c >= '0' && c <= '9')
            hi = c - '0';
        else if (c >= 'A' && c <= 'F')
            hi = c - 'A' + 10;
        else if (c >= 'a' && c <= 'f')
            hi = c - 'a' + 10;
        else
            return -1;
        if (!*hex)
            return -1;
        c = *hex++;
        if (c >= '0' && c <= '9')
            lo = c - '0';
        else if (c >= 'A' && c <= 'F')
            lo = c - 'A' + 10;
        else if (c >= 'a' && c <= 'f')
            lo = c - 'a' + 10;
        else
            return -1;
        buf[out++] = (uint8_t)((hi << 4) | lo);
    }
    return (int)out;
}

/**
 * 从十六进制串渲染 UTF-8 文本，使用 GBK 字库显示。
 * 命令名 cjk_hex 保留兼容；实际字体为 display_get_font("gbk")。
 * Example: display cjk_hex E6B58BE8AF95E4B8ADE69687
 *          display cjk_hex E4BDA0E5A5BD 10 20
 */
#define GBK_HEX_UTF8_BUF_SIZE 128
static int cmd_display_cjk_hex(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2)
    {
        shell_print(shell, "Usage: display cjk_hex <hex> [x] [y]");
        shell_print(shell, "  hex = UTF-8 bytes in hex, e.g. E6B58BE8AF95 = test");
        shell_print(shell, "  Optional: x y = position (default 10 10)");
        shell_print(shell, "Example: display cjk_hex E4BDA0E5A5BD, MentraOS = ni hao");
        return -EINVAL;
    }

    static uint8_t utf8_buf[GBK_HEX_UTF8_BUF_SIZE];
    int len = hex_string_to_utf8(argv[1], utf8_buf, GBK_HEX_UTF8_BUF_SIZE - 1);
    if (len < 0)
    {
        shell_error(shell, "Invalid hex (use 0-9 A-F, spaces allowed)");
        return -EINVAL;
    }
    utf8_buf[len] = '\0';

    int x = 10, y = 10;
    if (argc >= 4)
    {
        x = atoi(argv[2]);
        y = atoi(argv[3]);
    }
    else if (argc >= 3)
    {
        x = atoi(argv[2]);
    }

    mos_binfont_lvgl_deinit();
    display_update_xy_text((uint16_t)x, (uint16_t)y, (const char *)utf8_buf, 0, 0xFFFF);
    shell_print(shell, "OK text at (%d,%d) (%d bytes)", x, y, len);
    return 0;
}

/**
 * Display pattern selection command
 */
static int cmd_display_pattern(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_error(shell, "❌ Usage: display pattern <id>");
        shell_print(shell, "Available patterns:");
        shell_print(shell, "  0 - Chess pattern");
        shell_print(shell, "  1 - Horizontal zebra");
        shell_print(shell, "  2 - Vertical zebra");
        shell_print(shell, "  3 - Scrolling welcome text");
        shell_print(shell, "  4 - Protobuf text container (default)");
        shell_print(shell, "  5 - XY text positioning area");
        return -EINVAL;
    }

    int pattern_id = atoi(argv[1]);

    if (pattern_id < 0 || pattern_id > 5)
    {
        shell_error(shell, "❌ Pattern ID must be 0-5");
        return -EINVAL;
    }

    // Send pattern change command to LVGL thread
    display_cmd_t cmd = {.type = LCD_CMD_SHOW_PATTERN, .p.pattern = {.pattern_id = pattern_id}};

    // Use K_NO_WAIT to avoid blocking shell thread - LVGL will process it asynchronously
    if (k_msgq_put(&lvgl_display_msgq, &cmd, K_NO_WAIT) != 0)
    {
        shell_error(shell, "❌ Display command queue full");
        return -EBUSY;
    }

    shell_print(shell, "✅ Switched to pattern %d", pattern_id);
    LOG_INF("Display pattern changed to %d via shell command", pattern_id);

    return 0;
}

/**
 * Display battery level and charging state command
 */
static int cmd_display_battery(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2 || argc > 3)
    {
        shell_error(shell, "❌ Usage: display battery <level> [charging]");
        shell_print(shell, "Parameters:");
        shell_print(shell, "  level    : 0-100 (battery percentage)");
        shell_print(shell, "  charging : true/false (optional, charging state)");
        shell_print(shell, "");
        shell_print(shell, "Examples:");
        shell_print(shell, "  display battery 85           - Set battery to 85%%, not charging");
        shell_print(shell, "  display battery 65 true      - Set battery to 65%%, charging");
        shell_print(shell, "  display battery 25 false     - Set battery to 25%%, not charging");
        return -EINVAL;
    }

    int battery_level = atoi(argv[1]);

    if (battery_level < 0 || battery_level > 100)
    {
        shell_error(shell, "❌ Battery level must be 0-100");
        return -EINVAL;
    }

    // Parse charging state (optional parameter)
    bool charging = false;  // Default to not charging
    if (argc == 3)
    {
        if (strcmp(argv[2], "true") == 0 || strcmp(argv[2], "1") == 0)
        {
            charging = true;
        }
        else if (strcmp(argv[2], "false") == 0 || strcmp(argv[2], "0") == 0)
        {
            charging = false;
        }
        else
        {
            shell_error(shell, "❌ Charging state must be 'true' or 'false'");
            return -EINVAL;
        }
    }

    // Update the protobuf battery system (this will also send notifications to mobile app)
    protobuf_set_battery_level(battery_level);
    protobuf_set_charging_state(charging);

    // Create battery level display text with charging indicator
    static char battery_text[80];
    const char *battery_icon;
    const char *charging_indicator;

    // Select battery icon based on level
    if (battery_level >= 75)
    {
        battery_icon = "🔋";  // Full
    }
    else if (battery_level >= 50)
    {
        battery_icon = "🔋";  // Medium-high
    }
    else if (battery_level >= 25)
    {
        battery_icon = "🪫";  // Medium-low
    }
    else
    {
        battery_icon = "🪫";  // Low/Critical
    }

    // Add charging indicator
    charging_indicator = charging ? " ⚡" : "";

    snprintf(battery_text, sizeof(battery_text), "%s %d%%%s", battery_icon, battery_level, charging_indicator);

    // Show confirmation in shell only - don't interfere with active display pattern
    // The protobuf functions above already handle mobile app notifications automatically

    shell_print(shell, "✅ Battery: %d%% %s", battery_level, charging ? "(Charging ⚡)" : "(Not Charging)");
    shell_print(shell, "📡 Battery status sent to mobile app via protobuf");
    shell_print(shell, "ℹ️  Battery icon: %s", battery_text);
    shell_print(shell, "💡 Tip: Use 'display text' command to show battery on screen if needed");
    LOG_INF("Battery set: %d%% %s via shell command", battery_level, charging ? "charging" : "not charging");

    return 0;
}

/**
 * Display fill command (opposite of clear - fill with white)
 */
static int cmd_display_fill(const struct shell *shell, size_t argc, char **argv)
{
    // Use A6N driver's clear screen function with white fill
    // color_on = true means fill with white (foreground color)
    int ret = a6n_clear_screen(true);

    if (ret == 0)
    {
        shell_print(shell, "✅ Display filled with white");
        LOG_INF("Display filled via shell command using a6n_clear_screen(true)");
    }
    else
    {
        shell_error(shell, "❌ Failed to fill display (error: %d)", ret);
        LOG_ERR("Failed to fill display: %d", ret);
    }

    return ret;
}

/**
 * 显示测试命令 | Display test command
 */
static int cmd_display_selftest_patterns(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "🧪 运行 A6N 硬件自测试图案 | Running A6N hardware self-test patterns...");

    int ret;

    // 测试 1: 全黑 | Test 1: All black (0x80)
    shell_print(shell, "  ⬛ 测试图案 0x00: 全黑 | Pattern 0x00: All black (0x80)");
    ret = a6n_enable_selftest(true, 0x00);
    if (ret != 0)
    {
        shell_error(shell, "❌ 全黑图案失败 | Black pattern failed (error: %d)", ret);
        return ret;
    }
    k_sleep(K_MSEC(2000));  // 显示 2 秒 | Display for 2 seconds

    // 测试 2: 全亮 | Test 2: All white (0x81)
    shell_print(shell, "  ⬜ 测试图案 0x01: 全亮 | Pattern 0x01: All white (0x81)");
    ret = a6n_enable_selftest(true, 0x01);
    if (ret != 0)
    {
        shell_error(shell, "❌ 全亮图案失败 | White pattern failed (error: %d)", ret);
        return ret;
    }
    k_sleep(K_MSEC(2000));  // 显示 2 秒 | Display for 2 seconds

    // 测试 3: 2x2 棋盘格 | Test 3: 2x2 checkerboard (0x88)
    shell_print(shell, "  ♟️  测试图案 0x08: 2x2棋盘格 | Pattern 0x08: 2x2 checkerboard (0x88)");
    ret = a6n_enable_selftest(true, 0x08);
    if (ret != 0)
    {
        shell_error(shell, "❌ 2x2棋盘格失败 | 2x2 checkerboard failed (error: %d)", ret);
        return ret;
    }
    k_sleep(K_MSEC(2000));  // 显示 2 秒 | Display for 2 seconds

    // 测试 4: 4x4 棋盘格 | Test 4: 4x4 checkerboard (0x89)
    shell_print(shell, "  ♟️  测试图案 0x09: 4x4棋盘格 | Pattern 0x09: 4x4 checkerboard (0x89)");
    ret = a6n_enable_selftest(true, 0x09);
    if (ret != 0)
    {
        shell_error(shell, "❌ 4x4棋盘格失败 | 4x4 checkerboard failed (error: %d)", ret);
        return ret;
    }
    k_sleep(K_MSEC(2000));  // 显示 2 秒 | Display for 2 seconds

    // 关闭自测试模式 | Disable self-test mode
    shell_print(shell, "  🔄 关闭自测试模式 | Disabling self-test mode");
    ret = a6n_enable_selftest(false, 0x00);
    if (ret != 0)
    {
        shell_error(shell, "❌ 关闭自测试失败 | Failed to disable self-test (error: %d)", ret);
        return ret;
    }

    // 清屏 | Clear screen
    a6n_clear_screen(false);

    shell_print(shell, "✅ 显示测试完成 | Display test completed");
    shell_print(shell, "🎨 测试图案 | Test patterns: 全黑(0x80)/全亮(0x81)/2x2棋盘(0x88)/4x4棋盘(0x89)");
    shell_print(shell, "📐 使用 A6N 硬件自测试 (Bank1初始化 + Bank0 0x8F) | Using A6N hardware self-test (Bank1 init + Bank0 0x8F)");
    shell_print(shell, "⚠️  注意: 内部测试图 APL 较高，已使用较低亮度和短时间显示 | Note: High APL patterns, using low brightness and short duration");
    
    LOG_INF("A6N hardware self-test patterns completed");
    return 0;
}

/**
 * Display read command - Read A6N register (Bank0 default, supports bank1: prefix)
 */
static int cmd_display_read(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2 || argc > 3)  // 如果参数数量不正确；if the number of arguments is incorrect
    {
        shell_error(shell, "❌ Usage: display read <addr>|bank1:<addr> [mode]");
        shell_print(shell, "  addr: 8-bit hex register (e.g. 0xBE, 0xEF, 0xF0, 0xE2)");
        shell_print(shell, "  bank1:<addr> to read Bank1 register (e.g. bank1:0x55)");
        shell_print(shell, "  mode: engine selection for read command only");
        shell_print(shell, "        0 = left optical engine (default)");
        shell_print(shell, "        1 = right optical engine");
        shell_print(shell, "");
        shell_print(shell, "Examples:");
        shell_print(shell, "  display read 0xBE              - Read Bank0 reg 0xBE from left engine");
        shell_print(shell, "  display read 0xBE 1            - Read Bank0 reg 0xBE from right engine");
        shell_print(shell, "  display read bank1:0x55        - Read Bank1 reg 0x55 from left engine");
        shell_print(shell, "  display read bank1:0x55 1      - Read Bank1 reg 0x55 from right engine");
        return -EINVAL;
    }

    // Parse bank selector
    uint8_t bank_id = 0;  // default Bank0
    const char *arg = argv[1];
    if (strncmp(arg, "bank1:", 6) == 0)
    {
        bank_id = 1;
        arg += 6;
    }

    // Parse hex register address with strict validation
    // Must start with 0x prefix
    if (strncmp(arg, "0x", 2) != 0)
    {
        shell_error(shell, "❌ Invalid register address: '%s' (must use 0x prefix)", arg);
        shell_print(shell, "Valid examples: 0xBE, 0xEF, 0xF0, 0xE2");
        shell_print(shell, "❌ Do not use: BE, EF, 78, etc. (missing 0x prefix)");
        return -EINVAL;
    }

    char *endptr;
    unsigned long reg_val = strtoul(arg, &endptr, 16);

    // Check for parsing errors
    if (endptr == arg || *endptr != '\0')
    {
        shell_error(shell, "❌ Invalid register address: '%s' (use hex format like 0xBE)", arg);
        shell_print(shell, "Valid examples: 0xBE, 0xEF, 0xF0, 0xE2");
        return -EINVAL;
    }

    // Check range
    if (reg_val > 0xFF)
    {
        shell_error(shell, "❌ Register address out of range: 0x%lX (max: 0xFF)", reg_val);
        return -EINVAL;
    }

    uint8_t reg = (uint8_t)reg_val;

    // Parse mode: 0=left, 1=right (default=0)
    int mode = 0;
    if (argc == 3)
    {
        mode = atoi(argv[2]);
        if (mode < 0 || mode > 1)
        {
            shell_error(shell, "❌ Invalid mode: %d (must be 0=left or 1=right)", mode);
            return -EINVAL;
        }
    }

    int val = a6n_read_reg(bank_id, mode, reg);
    if (val < 0)
    {
        shell_error(shell, "❌ Read failed [bank%d reg=0x%02X mode=%d]: %d", bank_id, reg, mode, val);
        return val;
    }

    const char *engine = (mode == 0) ? "left" : "right";
    shell_print(shell, "✅ A6N[bank%d] reg 0x%02X = 0x%02X (%s engine)", bank_id, reg, (uint8_t)val, engine);
    return 0;
}

/**
 * Display write command - Write A6N register (Bank0 default, supports bank1: prefix)
 */
static int cmd_display_write(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 3)
    {
        shell_error(shell, "❌ Usage: display write <addr>|bank1:<addr> <value>");
        shell_print(shell, "  addr: 8-bit hex register (e.g. 0xBE, 0xEF, 0xF0, 0xE2)");
        shell_print(shell, "  bank1:<addr> to write Bank1 register (e.g. bank1:0x55)");
        shell_print(shell, "  value: 8-bit hex (e.g. 0x84)");
        return -EINVAL;
    }

    // Parse bank selector and register
    uint8_t bank_id = 0;
    const char *arg = argv[1];
    if (strncmp(arg, "bank1:", 6) == 0)
    {
        bank_id = 1;
        arg += 6;
    }
    // Parse hex register address with strict validation
    // Must start with 0x prefix
    if (strncmp(arg, "0x", 2) != 0)
    {
        shell_error(shell, "❌ Invalid register address: '%s' (must use 0x prefix)", arg);
        shell_print(shell, "Valid examples: 0xBE, 0xEF, 0xF0, 0xE2");
        shell_print(shell, "❌ Do not use: BE, EF, 78, etc. (missing 0x prefix)");
        return -EINVAL;
    }

    char *endptr;
    unsigned long reg_val = strtoul(arg, &endptr, 16);

    // Check for parsing errors
    if (endptr == arg || *endptr != '\0')
    {
        shell_error(shell, "❌ Invalid register address: '%s' (use hex format like 0xBE)", arg);
        shell_print(shell, "Valid examples: 0xBE, 0xEF, 0xF0, 0xE2");
        return -EINVAL;
    }

    // Check range
    if (reg_val > 0xFF)
    {
        shell_error(shell, "❌ Register address out of range: 0x%lX (max: 0xFF)", reg_val);
        return -EINVAL;
    }

    uint8_t reg = (uint8_t)reg_val;

    // Parse value with strict validation
    // Must start with 0x prefix
    if (strncmp(argv[2], "0x", 2) != 0)
    {
        shell_error(shell, "❌ Invalid value: '%s' (must use 0x prefix)", argv[2]);
        shell_print(shell, "Valid examples: 0x84, 0x00, 0xFF");
        shell_print(shell, "❌ Do not use: 84, 0, 255, etc. (missing 0x prefix)");
        return -EINVAL;
    }

    char *val_endptr;
    unsigned long val_val = strtoul(argv[2], &val_endptr, 16);

    // Check for parsing errors
    if (val_endptr == argv[2] || *val_endptr != '\0')
    {
        shell_error(shell, "❌ Invalid value: '%s' (use hex format like 0x84)", argv[2]);
        shell_print(shell, "Valid examples: 0x84, 0x00, 0xFF");
        return -EINVAL;
    }

    // Check range
    if (val_val > 0xFF)
    {
        shell_error(shell, "❌ Value out of range: 0x%lX (max: 0xFF)", val_val);
        return -EINVAL;
    }

    uint8_t val = (uint8_t)val_val;

    int ret = a6n_write_reg(bank_id, reg, val);
    if (ret != 0)
    {
        shell_error(shell, "❌ Write failed [bank%d reg=0x%02X val=0x%02X]: %d", bank_id, reg, val, ret);
        return ret;
    }

    shell_print(shell, "✅ A6N[bank%d] reg 0x%02X ← 0x%02X", bank_id, reg, val);
    return 0;
}

/**
 * Display stereo shift command
 * Usage: display stereo <left_h> <right_h>
 */
static int cmd_display_stereo(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 3)
    {
        shell_error(shell, "Usage: display stereo <left_h> <right_h>");
        return -EINVAL;
    }

    char *endptr = NULL;
    long left_h = strtol(argv[1], &endptr, 10);
    if (*endptr != '\0' || left_h < 0 || left_h > 16)
    {
        shell_error(shell, "❌ Invalid left_h: %s (range: 0..16)", argv[1]);
        return -EINVAL;
    }

    long right_h = strtol(argv[2], &endptr, 10);
    if (*endptr != '\0' || right_h < 0 || right_h > 16)
    {
        shell_error(shell, "❌ Invalid right_h: %s (range: 0..16)", argv[2]);
        return -EINVAL;
    }

    int ret = a6n_set_stereo_shift((uint8_t)left_h, (uint8_t)right_h);
    if (ret != 0)
    {
        shell_error(shell, "❌ Stereo shift failed: %d", ret);
        return ret;
    }

    shell_print(shell, "✅ Stereo shift set: LH=%ld RH=%ld (H-only, mirror preserved)", left_h, right_h);
    shell_print(shell, "   Tip: near feeling usually uses LH>8 and RH<8.");
    return 0;
}

/**
 * Display one-parameter depth command (pure software mode)
 * Usage: display depth <offset>
 *   offset: -16..16, used as software disparity (left=+offset, right=-offset)
 */
static int cmd_display_depth(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2)
    {
        shell_error(shell, "Usage: display depth <offset>");
        return -EINVAL;
    }

    char *endptr = NULL;
    long offset = strtol(argv[1], &endptr, 10);
    if (*endptr != '\0' || offset < -16 || offset > 16)
    {
        shell_error(shell, "❌ Invalid offset: %s (range: -16..16)", argv[1]);
        return -EINVAL;
    }

    int ret = a6n_set_software_depth_offset((int8_t)offset);
    if (ret != 0)
    {
        shell_error(shell, "❌ Depth apply failed: %d", ret);
        return ret;
    }

    display_request_visible_redraw();
    shell_print(shell, "✅ Software depth set: offset=%ld px (pure software disparity)", offset);
    shell_print(shell, "   Visible UI refresh queued. Use \"display redraw\" for full screen if needed.");
    return 0;
}

/**
 * Display distance command (trigonometry model)
 * Usage: display distance <meters>
 *   meters: 2.0..5.0, default 2.5m => offset 0
 */
static int cmd_display_distance(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2)
    {
        shell_error(shell, "Usage: display distance <meters>");
        return -EINVAL;
    }

    char *endptr = NULL;
    double distance_m = strtod(argv[1], &endptr);
    if (endptr == argv[1] || *endptr != '\0')
    {
        shell_error(shell, "❌ Invalid distance: %s", argv[1]);
        return -EINVAL;
    }

    if (distance_m <= 0.0)
    {
        shell_error(shell, "❌ Invalid distance: %.3f m", distance_m);
        return -EINVAL;
    }

    uint32_t requested_cm = (uint32_t)((distance_m * 100.0) + 0.5);
    int8_t offset = 0;
    uint32_t clamped_cm = 0U;
    int ret = a6n_depth_distance_cm_to_offset(requested_cm, &offset, &clamped_cm);
    if (ret != 0)
    {
        shell_error(shell, "❌ Distance calculate failed: %d", ret);
        return ret;
    }

    ret = a6n_set_software_depth_offset(offset);
    if (ret != 0)
    {
        shell_error(shell, "❌ Distance apply failed: %d", ret);
        return ret;
    }

    display_request_visible_redraw();
    shell_print(shell, "✅ Distance set: request=%.2fm (%u cm), clamp=%.2fm, offset=%d px",
                distance_m, (unsigned int)requested_cm, (double)clamped_cm / 100.0, (int)offset);
    shell_print(shell, "   Visible UI refresh queued. Use \"display redraw\" for full screen if needed.");
    return 0;
}

static int cmd_display_distance_test(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    static const uint32_t test_cm[] = {200U, 225U, 250U, 300U, 400U, 500U};

    shell_print(shell, "Distance trigonometry test (default 2.50m => 0px):");
    for (size_t i = 0; i < (sizeof(test_cm) / sizeof(test_cm[0])); ++i)
    {
        int8_t offset = 0;
        uint32_t clamped_cm = 0U;
        int ret = a6n_depth_distance_cm_to_offset(test_cm[i], &offset, &clamped_cm);
        if (ret != 0)
        {
            shell_error(shell, "  %.2fm -> error %d", (double)test_cm[i] / 100.0, ret);
            continue;
        }
        shell_print(shell, "  %.2fm -> clamp %.2fm -> offset %+d px",
                    (double)test_cm[i] / 100.0, (double)clamped_cm / 100.0, (int)offset);
    }

    return 0;
}

/**
 * Simulate legacy protobuf DisplayDistanceConfig tier mapping locally.
 *
 * 1 => 2.0m, 2 => 2.5m, 3 => 5.0m, then use the trigonometry model.
 */
static int cmd_display_distance_tier(const struct shell *shell, size_t argc, char **argv)
{
    if (argc < 2)
    {
        shell_error(shell, "Usage: display distance_tier <1|2|3>");
        return -EINVAL;
    }

    char *endptr = NULL;
    long v = strtol(argv[1], &endptr, 10);
    if (*endptr != '\0' || (v != 1L && v != 2L && v != 3L))
    {
        shell_error(shell, "❌ Invalid tier: %s (expected 1/2/3)", argv[1]);
        return -EINVAL;
    }

    mentraos_ble_DisplayDistanceConfig cfg = {0};
    cfg.distance_cm = (uint32_t)v;

    protobuf_process_display_distance_config(&cfg);
    shell_print(shell, "✅ legacy distance_tier=%ld applied (1=2.0m, 2=2.5m, 3=5.0m).", v);
    return 0;
}

static int cmd_display_redraw(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;
    display_request_full_redraw();
    shell_print(shell, "✅ Full redraw requested (LVGL thread)");
    return 0;
}

static int cmd_display_redraw_visible(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;
    display_request_visible_redraw();
    shell_print(shell, "✅ Visible UI redraw requested (LVGL thread)");
    return 0;
}

/**
 * A6N temperature reading sequence
 * Returns temperature in Celsius on success, or negative error code on failure
 *
 * @param temp_out Pointer to store temperature value (in Celsius)
 * @return 0 on success, negative error code on failure
 */
static int a6n_read_temperature(int16_t *temp_out)
{
    if (temp_out == NULL)
    {
        return -EINVAL;
    }

    // Step 1: Send temperature reading sequence
    int ret;

    // Initialize temperature reading sequence
    ret = a6n_write_reg(0, 0x0B, 0xFF);
    if (ret != 0)
        return ret;
    k_busy_wait(1);

    ret = a6n_write_reg(0, 0x7E, 0x88);
    if (ret != 0)
        return ret;
    k_busy_wait(1);

    ret = a6n_write_reg(0, 0x7E, 0x08);
    if (ret != 0)
        return ret;
    k_busy_wait(1);

    ret = a6n_write_reg(0, 0xD2, 0x01);
    if (ret != 0)
        return ret;
    k_busy_wait(1);

    ret = a6n_write_reg(0, 0xD4, 0x00);
    if (ret != 0)
        return ret;
    k_busy_wait(1);

    ret = a6n_write_reg(0, 0x7D, 0x04);
    if (ret != 0)
        return ret;
    k_busy_wait(100);

    ret = a6n_write_reg(0, 0x7D, 0x00);
    if (ret != 0)
        return ret;
    k_busy_wait(1);

    ret = a6n_write_reg(0, 0xD4, 0x00);
    if (ret != 0)
        return ret;
    k_busy_wait(1);

    ret = a6n_write_reg(0, 0x0B, 0x0A);
    if (ret != 0)
        return ret;
    k_busy_wait(1);

    // Step 2: Read temperature registers (mode=1 for right engine)
    // First read 0xD0 (required for temperature measurement sequence)
    ret = a6n_read_reg(0, 1, 0xD0);
    if (ret < 0)
        return ret;

    // Then read 0xD8 (actual temperature value)
    int temp_raw = a6n_read_reg(0, 1, 0xD8);
    if (temp_raw < 0)
        return temp_raw;

    // Step 3: Convert to Celsius: T = (val*5/7) - 50
    *temp_out = (temp_raw * 5 / 7) - 50;

    return 0;
}

/**
 * Display get temperature command
 */
static int cmd_display_get_temp(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "🌡️  Reading A6N panel temperature...");

    int16_t temp;
    int ret = a6n_read_temperature(&temp);
    if (ret != 0)
    {
        shell_error(shell, "❌ Temperature reading failed: error %d", ret);
        return ret;
    }

    shell_print(shell, "✅ Panel temperature: %d°C", temp);

    // Read temperature protection thresholds from hardware registers
    int high_protect_raw = a6n_read_reg(0, 1, A6N_LCD_TEMP_HIGH_REG);
    int low_recover_raw = a6n_read_reg(0, 1, A6N_LCD_TEMP_LOW_REG);

    if (high_protect_raw >= 0 && low_recover_raw >= 0)
    {
        // Convert raw values to Celsius: T = (val*5/7) - 50
        int16_t high_protect = (high_protect_raw * 5 / 7) - 50;
        int16_t low_recover = (low_recover_raw * 5 / 7) - 50;

        shell_print(shell, "📊 Protection thresholds:");
        shell_print(shell, "   High temperature: %d°C (reg 0x%02X = 0x%02X)", high_protect, A6N_LCD_TEMP_HIGH_REG,
                    high_protect_raw);
        shell_print(shell, "   Low recovery: %d°C (reg 0x%02X = 0x%02X)", low_recover, A6N_LCD_TEMP_LOW_REG,
                    low_recover_raw);

        // Check against limits
        if (temp >= high_protect)
        {
            shell_warn(shell, "⚠️  Temperature at or above high protection threshold: %d°C ≥ %d°C", temp, high_protect);
        }
        else if (temp <= low_recover)
        {
            shell_warn(shell, "⚠️  Temperature at or below low recovery threshold: %d°C ≤ %d°C", temp, low_recover);
        }
        else
        {
            shell_print(shell, "✅ Temperature within normal range: %d°C < %d°C < %d°C", low_recover, temp,
                        high_protect);
        }
    }
    else
    {
        shell_warn(shell, "⚠️  Could not read protection thresholds from hardware");
    }

    return 0;
}

/**
 * Display set low temperature recovery threshold command
 * Writes to A6N register 0xF8
 */
static int cmd_display_min_temp_limit_set(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_error(shell, "❌ Usage: display min_temp_limit set <value_in_C>");
        shell_print(shell, "  value_in_C: Low temperature recovery threshold in Celsius");
        shell_print(shell, "  Formula: reg_value = (temp + 50) * 7 / 5");
        shell_print(shell, "Examples:");
        shell_print(shell, "  display min_temp_limit set 0    - Set low recovery to 0°C");
        shell_print(shell, "  display min_temp_limit set -10  - Set low recovery to -10°C");
        return -EINVAL;
    }

    int temp_celsius = atoi(argv[1]);

    // Check temperature range per A6N specification
    if (temp_celsius < -30 || temp_celsius > 70)
    {
        shell_error(shell, "❌ Temperature %d°C out of valid range", temp_celsius);
        shell_print(shell, "📋 Valid range: -30°C to +70°C (per A6N spec)");
        return -EINVAL;
    }

    // Convert Celsius to register value: val = (T + 50) * 7 / 5
    int reg_value = (temp_celsius + 50) * 7 / 5;

    // Write to hardware register
    int ret = a6n_write_reg(0, A6N_LCD_TEMP_LOW_REG, (uint8_t)reg_value);
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to write register 0x%02X: error %d", A6N_LCD_TEMP_LOW_REG, ret);
        return ret;
    }

    shell_print(shell, "✅ Low temperature recovery threshold set to: %d°C (reg 0x%02X = 0x%02X)", temp_celsius,
                A6N_LCD_TEMP_LOW_REG, reg_value);
    return 0;
}

/**
 * Display get low temperature recovery threshold command
 * Reads from A6N register 0xF8
 */
static int cmd_display_min_temp_limit_get(const struct shell *shell, size_t argc, char **argv)
{
    int reg_value = a6n_read_reg(0, 1, A6N_LCD_TEMP_LOW_REG);
    if (reg_value < 0)
    {
        shell_error(shell, "❌ Failed to read register 0x%02X: error %d", A6N_LCD_TEMP_LOW_REG, reg_value);
        return reg_value;
    }

    // Convert to Celsius: T = (val*5/7) - 50
    int16_t temp_celsius = (reg_value * 5 / 7) - 50;

    shell_print(shell, "✅ Low temperature recovery threshold: %d°C (reg 0x%02X = 0x%02X)", temp_celsius,
                A6N_LCD_TEMP_LOW_REG, reg_value);
    return 0;
}

/**
 * Display set high temperature protection threshold command
 * Writes to A6N register 0xF7
 */
static int cmd_display_max_temp_limit_set(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_error(shell, "❌ Usage: display max_temp_limit set <value_in_C>");
        shell_print(shell, "  value_in_C: High temperature protection threshold in Celsius");
        shell_print(shell, "  Formula: reg_value = (temp + 50) * 7 / 5");
        shell_print(shell, "Examples:");
        shell_print(shell, "  display max_temp_limit set 50   - Set high protection to 50°C");
        shell_print(shell, "  display max_temp_limit set 65   - Set high protection to 65°C");
        return -EINVAL;
    }

    int temp_celsius = atoi(argv[1]);

    // Check temperature range per A6N specification
    if (temp_celsius < -30 || temp_celsius > 70)
    {
        shell_error(shell, "❌ Temperature %d°C out of valid range", temp_celsius);
        shell_print(shell, "📋 Valid range: -30°C to +70°C (per A6N spec)");
        return -EINVAL;
    }

    // Convert Celsius to register value: val = (T + 50) * 7 / 5
    int reg_value = (temp_celsius + 50) * 7 / 5;

    // Write to hardware register
    int ret = a6n_write_reg(0, A6N_LCD_TEMP_HIGH_REG, (uint8_t)reg_value);
    if (ret != 0)
    {
        shell_error(shell, "❌ Failed to write register 0x%02X: error %d", A6N_LCD_TEMP_HIGH_REG, ret);
        return ret;
    }

    shell_print(shell, "✅ High temperature protection threshold set to: %d°C (reg 0x%02X = 0x%02X)", temp_celsius,
                A6N_LCD_TEMP_HIGH_REG, reg_value);
    return 0;
}

/**
 * Display get high temperature protection threshold command
 * Reads from A6N register 0xF7
 */
static int cmd_display_max_temp_limit_get(const struct shell *shell, size_t argc, char **argv)
{
    int reg_value = a6n_read_reg(0, 1, A6N_LCD_TEMP_HIGH_REG);
    if (reg_value < 0)
    {
        shell_error(shell, "❌ Failed to read register 0x%02X: error %d", A6N_LCD_TEMP_HIGH_REG, reg_value);
        return reg_value;
    }

    // Convert to Celsius: T = (val*5/7) - 50
    int16_t temp_celsius = (reg_value * 5 / 7) - 50;

    shell_print(shell, "✅ High temperature protection threshold: %d°C (reg 0x%02X = 0x%02X)", temp_celsius,
                A6N_LCD_TEMP_HIGH_REG, reg_value);
    return 0;
}

/**
 * Font list command - Show all available font sizes
 */
static int cmd_display_fonts_list(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "📝 Available English Font Sizes (Montserrat):");
    shell_print(shell, "");
    shell_print(shell, "  12pt - Small text (good for details)");
    shell_print(shell, "  14pt - Body text (readable, default)");
    // shell_print(shell, "  30pt - Title size (prominent)");  // 30pt font commented out
    shell_print(shell, "  48pt - Display size (very large)");
    shell_print(shell, "");
    shell_print(shell, "Note: 16pt, 18pt, 24pt fonts require LVGL configuration");
    shell_print(shell, "Usage: display text \"Hello\" <x> <y> <size>");
    shell_print(shell, "");
    return 0;
}

/**
 * Font test command - Test all font sizes
 */
static int cmd_display_fonts_test(const struct shell *shell, size_t argc, char **argv)
{
    const int font_sizes[] = {12, 14, 16, 18, 24, 48}; /* 30pt commented out */
    const char *test_text = "Font Test";
    int y_pos = 20;

    shell_print(shell, "Testing all font sizes with text: \"%s\"", test_text);

    // Switch to Pattern 5 for XY positioning
    // Switch to Pattern 5 (XY positioning) for testing
    display_cmd_t cmd = {.type = LCD_CMD_SHOW_PATTERN, .p.pattern = {.pattern_id = 5}};

    if (k_msgq_put(&lvgl_display_msgq, &cmd, K_NO_WAIT) != 0)
    {
        shell_print(shell, "⚠️ Could not switch to Pattern 5 for testing");
    }
    else
    {
        shell_print(shell, "📝 Switched to Pattern 5 (XY) for font testing");
    }

    for (int i = 0; i < ARRAY_SIZE(font_sizes); i++)
    {
        int size = font_sizes[i];
        char size_label[32];
        snprintf(size_label, sizeof(size_label), "%dpt: %s", size, test_text);

        // Display the font size test
        display_update_xy_text(10, y_pos, size_label, size, 0xFFFF);

        shell_print(shell, "  %dpt font displayed at y=%d", size, y_pos);

        // Calculate next Y position based on font size
        y_pos += size + 10;  // Font size + 10px spacing

        if (y_pos > 400)
        {  // Avoid going off screen
            shell_print(shell, "  (remaining fonts would exceed screen height)");
            break;
        }
    }

    shell_print(shell, "Font test completed. All sizes displayed on Pattern 5.");
    return 0;
}

/**
 * Layout info command - Show current layout settings
 */
static int cmd_display_layout_info(const struct shell *shell, size_t argc, char **argv)
{
    shell_print(shell, "");
    shell_print(shell, "📐 Current Layout Configuration:");
    shell_print(shell, "");
    shell_print(shell, "Display Information:");
    shell_print(shell, "  Type: HongShi A6N Projector");
    shell_print(shell, "  Physical size: 640x480 pixels");
    shell_print(shell, "");
    shell_print(shell, "Container Layout (Default):");
    shell_print(shell, "  Margin: 10 pixels (distance from screen edges)");
    shell_print(shell, "  Padding: 8 pixels (internal container padding)");
    shell_print(shell, "  Border width: 2 pixels");
    shell_print(shell, "  Usable area: 440x200 pixels");
    shell_print(shell, "");
    shell_print(shell, "Font Information:");
    shell_print(shell, "  Available fonts: 12pt, 14pt, 48pt Montserrat (30pt commented out)");
    shell_print(shell, "  Current default: 14pt");
    shell_print(shell, "");
    shell_print(shell, "Note: Full configuration API under development");
    shell_print(shell, "");
    return 0;
}

/**
 * Layout margin command - Set container margin
 */
static int cmd_display_layout_margin(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_print(shell, "Usage: display layout margin <pixels>");
        shell_print(shell, "Current margin: 10 pixels (default)");
        return -EINVAL;
    }

    int margin = atoi(argv[1]);
    if (margin < 0 || margin > 50)
    {
        shell_print(shell, "Error: Margin must be between 0-50 pixels");
        return -EINVAL;
    }

    shell_print(shell, "⚠️  Dynamic margin changes not yet implemented.");
    shell_print(shell, "To change margin from default 10px to %dpx:", margin);
    shell_print(shell, "  1. Edit src/mos_components/mos_lvgl_display/src/display_config.c");
    shell_print(shell, "  2. Find DISPLAY_TYPE_A6N_640x480 section");
    shell_print(shell, "  3. Change .margin_left / .margin_top in display_config.c to %d", margin);
    shell_print(shell, "  4. Rebuild and flash firmware");
    shell_print(shell, "");
    return 0;
}

/**
 * Layout padding command - Set container padding
 */
static int cmd_display_layout_padding(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_print(shell, "Usage: display layout padding <pixels>");
        shell_print(shell, "Current padding: 10 pixels (default)");
        return -EINVAL;
    }

    int padding = atoi(argv[1]);
    if (padding < 0 || padding > 50)
    {
        shell_print(shell, "Error: Padding must be between 0-50 pixels");
        return -EINVAL;
    }

    shell_print(shell, "⚠️  Dynamic padding changes not yet implemented.");
    shell_print(shell, "To change padding from default 10px to %dpx:", padding);
    shell_print(shell, "  1. Edit src/mos_components/mos_lvgl_display/src/display_config.c");
    shell_print(shell, "  2. Find DISPLAY_TYPE_A6N_640x480 section");
    shell_print(shell, "  3. Change .padding = 10 to .padding = %d", padding);
    shell_print(shell, "  4. Rebuild and flash firmware");
    shell_print(shell, "");
    return 0;
}

/* AUTO brightness shell commands */
static int cmd_display_auto_status(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);
    mos_brightness_status_t status = {0};
    mos_brightness_get_status(&status);
    shell_print(shell, "AUTO brightness: %s", status.auto_enabled ? "ON" : "OFF");
    shell_print(shell, "  Multiplier : %.2f", (double)status.multiplier);
    if (status.last_lux < 0.0f)
    {
        shell_print(shell, "  Last lux   : not sampled yet");
    }
    else
    {
        shell_print(shell, "  Last lux   : %.2f lx", (double)status.last_lux);
    }
    if (status.filtered_lux < 0.0f)
    {
        shell_print(shell, "  Filter lux : not initialized");
    }
    else
    {
        shell_print(shell, "  Filter lux : %.2f lx", (double)status.filtered_lux);
    }
    shell_print(shell, "  Sensor err : %d", status.last_sensor_error);
    shell_print(shell, "  Sample log : %s", status.sample_log_enabled ? "ON" : "OFF");
    shell_print(shell, "  Current    : %u%%", status.current_level_percent);
    shell_print(shell, "  Note       : AUTO samples every 1500 ms when enabled");
    return 0;
}

static int cmd_display_auto_on(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);
    mos_brightness_request_auto_enabled(true);
    shell_print(shell, "✅ AUTO brightness enabled");
    shell_print(shell, "   Check with: display brightness auto status");
    shell_print(shell, "   Log tag: mos_brightness, sample interval: 1500 ms");
    return 0;
}

static int cmd_display_auto_off(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);
    mos_brightness_request_auto_enabled(false);
    shell_print(shell, "✅ AUTO brightness disabled, manual level restored");
    return 0;
}

static int cmd_display_auto_multiplier(const struct shell *shell, size_t argc, char **argv)
{
    mos_brightness_status_t status = {0};

    if (argc != 2)
    {
        shell_error(shell, "Usage: display brightness auto multiplier <0.10-3.00>");
        mos_brightness_get_status(&status);
        shell_print(shell, "  Current: %.2f", (double)status.multiplier);
        return -EINVAL;
    }
    char *endptr = NULL;
    float val = strtof(argv[1], &endptr);
    if ((endptr == argv[1]) || (*endptr != '\0'))
    {
        shell_error(shell, "Invalid multiplier: %s", argv[1]);
        shell_print(shell, "Usage: display brightness auto multiplier <0.10-3.00>");
        return -EINVAL;
    }
    mos_brightness_request_multiplier(val);
    mos_brightness_get_status(&status);
    shell_print(shell, "✅ Multiplier set to %.2f (clamped if out of range)", (double)status.multiplier);
    return 0;
}

static int cmd_display_auto_log_on(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);
    mos_brightness_set_sample_log_enabled(true);
    shell_print(shell, "✅ AUTO brightness sample log enabled");
    return 0;
}

static int cmd_display_auto_log_off(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);
    mos_brightness_set_sample_log_enabled(false);
    shell_print(shell, "✅ AUTO brightness sample log disabled");
    return 0;
}

static int cmd_display_auto_log_status(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);
    mos_brightness_status_t status = {0};
    mos_brightness_get_status(&status);
    shell_print(shell, "AUTO brightness sample log: %s", status.sample_log_enabled ? "ON" : "OFF");
    return 0;
}

/* Shell subcommand definitions for fonts */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_fonts,
                               SHELL_CMD(list, NULL, "List all available font sizes", cmd_display_fonts_list),
                               SHELL_CMD(test, NULL, "Test all font sizes with sample text", cmd_display_fonts_test),
                               SHELL_SUBCMD_SET_END);

/* Shell command definitions for binfont test */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_binfont, SHELL_CMD(test, NULL, "Show binfont test text", cmd_display_binfont_test),
                               SHELL_SUBCMD_SET_END);

/* Shell subcommand definitions for layout */
SHELL_STATIC_SUBCMD_SET_CREATE(
    sub_layout, SHELL_CMD(info, NULL, "Show current layout configuration", cmd_display_layout_info),
    SHELL_CMD_ARG(margin, NULL, "Set container margin <pixels>", cmd_display_layout_margin, 2, 0),
    SHELL_CMD_ARG(padding, NULL, "Set container padding <pixels>", cmd_display_layout_padding, 2, 0),
    SHELL_SUBCMD_SET_END);

/* Shell subcommand definitions for min_temp_limit */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_min_temp_limit,
                               SHELL_CMD_ARG(set, NULL, "Set low temperature recovery threshold <value_in_C>",
                                             cmd_display_min_temp_limit_set, 2, 0),
                               SHELL_CMD(get, NULL, "Get low temperature recovery threshold",
                                         cmd_display_min_temp_limit_get),
                               SHELL_SUBCMD_SET_END);

/* Shell subcommand definitions for max_temp_limit */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_max_temp_limit,
                               SHELL_CMD_ARG(set, NULL, "Set high temperature protection threshold <value_in_C>",
                                             cmd_display_max_temp_limit_set, 2, 0),
                               SHELL_CMD(get, NULL, "Get high temperature protection threshold",
                                         cmd_display_max_temp_limit_get),
                               SHELL_SUBCMD_SET_END);

/* Shell subcommand definitions for auto brightness sample logs */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_brightness_auto_log,
                               SHELL_CMD(on, NULL, "Enable AUTO sample log", cmd_display_auto_log_on),
                               SHELL_CMD(off, NULL, "Disable AUTO sample log", cmd_display_auto_log_off),
                               SHELL_CMD(status, NULL, "Show AUTO sample log state", cmd_display_auto_log_status),
                               SHELL_SUBCMD_SET_END);

/* Shell subcommand definitions for auto brightness */
SHELL_STATIC_SUBCMD_SET_CREATE(
    sub_brightness_auto,
    SHELL_CMD(status, NULL, "Show AUTO brightness state (enabled, lux, %%, multiplier)", cmd_display_auto_status),
    SHELL_CMD(on, NULL, "Enable AUTO brightness (ambient light sensor)", cmd_display_auto_on),
    SHELL_CMD(off, NULL, "Disable AUTO brightness, restore manual level", cmd_display_auto_off),
    SHELL_CMD(log, &sub_brightness_auto_log, "AUTO sample log control (on/off/status)", cmd_display_auto_log_status),
    SHELL_CMD_ARG(multiplier, NULL, "Set AUTO brightness multiplier <0.10-3.00>", cmd_display_auto_multiplier, 2, 0),
    SHELL_SUBCMD_SET_END);

/* Shell subcommand definitions for brightness */
SHELL_STATIC_SUBCMD_SET_CREATE(
    sub_brightness,
    SHELL_CMD(auto, &sub_brightness_auto, "AUTO brightness control (on/off/status/multiplier)",
              cmd_display_auto_status),
    SHELL_SUBCMD_SET_END);

/* Shell command definitions */
SHELL_STATIC_SUBCMD_SET_CREATE(
    sub_display, SHELL_CMD(help, NULL, "Show display commands help", cmd_display_help),
    SHELL_CMD(info, NULL, "Show display information", cmd_display_info),
    SHELL_CMD_ARG(brightness, &sub_brightness, "Set brightness <0-100> (disables AUTO)", cmd_display_brightness, 2, 0),
    SHELL_CMD(clear, NULL, "Clear display", cmd_display_clear),
    SHELL_CMD(fill, NULL, "Fill display with white", cmd_display_fill),
    SHELL_CMD_ARG(text, NULL, "Write text: \"string\" [x y size] (overlay or positioned)", cmd_display_text, 2, 3),
    SHELL_CMD(binfont, &sub_binfont, "Binfont test command", NULL),
    SHELL_CMD(bin_test, NULL, "Show binfont test text", cmd_display_binfont_test),
    SHELL_CMD(bt, NULL, "Show binfont test text", cmd_display_binfont_test),
    SHELL_CMD(b_t, NULL, "Show binfont test text", cmd_display_binfont_test),
    SHELL_CMD_ARG(cjk_hex, NULL, "Show UTF-8 text from hex: cjk_hex <hex> [x] [y]", cmd_display_cjk_hex, 2, 2),
    SHELL_CMD_ARG(pattern, NULL, "Select pattern (0-5): 0=chess, 1=h-zebra, 2=v-zebra, 3=scroll, 4=container, 5=xy",
                  cmd_display_pattern, 2, 0),
    SHELL_CMD_ARG(battery, NULL, "Set battery level & charging: <level> [true/false]", cmd_display_battery, 2, 1),
    SHELL_CMD_ARG(depth, NULL, "One-param depth: <offset>", cmd_display_depth, 2, 0),
    SHELL_CMD_ARG(distance, NULL, "Distance by meters: <meters>", cmd_display_distance, 2, 0),
    SHELL_CMD(distance_test, NULL, "Print distance trigonometry table", cmd_display_distance_test),
    SHELL_CMD_ARG(distance_tier, NULL, "Simulate legacy tier: <1|2|3>", cmd_display_distance_tier, 2, 0),
    SHELL_CMD(redraw, NULL, "Force full LVGL screen invalidate + refresh", cmd_display_redraw),
    SHELL_CMD(redraw_visible, NULL, "Invalidate current pattern UI only", cmd_display_redraw_visible),
    SHELL_CMD_ARG(stereo, NULL, "Set stereo shift: <left_h> <right_h>", cmd_display_stereo, 3, 0),
    SHELL_CMD(fonts, &sub_fonts, "Font size management", NULL),
    SHELL_CMD(layout, &sub_layout, "Layout and positioning control", NULL),
    SHELL_CMD_ARG(read, NULL, "Read A6N register: <addr> [mode] (hex, e.g. EF, F0, BE)", cmd_display_read, 2, 1),
    SHELL_CMD_ARG(write, NULL, "Write A6N register: <addr> <value> (hex)", cmd_display_write, 3, 0),
    SHELL_CMD(get_temp, NULL, "Read A6N panel temperature", cmd_display_get_temp),
    SHELL_CMD(min_temp_limit, &sub_min_temp_limit, "Low temperature recovery threshold control", NULL),
    SHELL_CMD(max_temp_limit, &sub_max_temp_limit, "High temperature protection threshold control", NULL),
    SHELL_CMD(selftest, NULL, "Run A6N hardware self-test patterns", cmd_display_selftest_patterns),
    SHELL_SUBCMD_SET_END /* Array terminated. */
);

SHELL_CMD_REGISTER(display, &sub_display, "Display control commands", cmd_display_help);
