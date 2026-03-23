/*
 * @Author       : Cole
 * @Date         : 2026-01-30 09:30:43
 * @LastEditTime : 2026-01-30 09:35:59
 * @FilePath     : display_config.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */


#include "display_config.h"

#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/display.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(display_config, LOG_LEVEL_DBG);

// Global configuration state
static display_config_t current_config;
static bool config_initialized = false;

/**
 * @brief Predefined display configurations for different display types
 */
static const display_config_t display_configs[DISPLAY_TYPE_MAX] = {
    // DISPLAY_TYPE_UNKNOWN - Default fallback
    [DISPLAY_TYPE_UNKNOWN] = {
        .type = DISPLAY_TYPE_UNKNOWN,
        .name = "Unknown Display",
        .width = 128, .height = 64,
        .layout = {
            .margin_left = 2, .margin_top = 2, .padding = 2, .border_width = 1,
            .usable_width = 124, .usable_height = 60
        },
        .fonts = {
            .primary = &lv_font_montserrat_12,
            .secondary = &lv_font_montserrat_12,  // Use 12 instead of 10 (not available)
            .large = &lv_font_montserrat_14,
            .cjk = &lv_font_montserrat_48,
            .line_spacing = 1
        },
        .patterns = {
            .chess_square_size = 8, .bar_thickness = 4, .scroll_speed = 2
        },
        .performance = {
            .refresh_rate_ms = 16, .animation_enabled = 1, .max_text_length = 128
        },
        .color_config = {
            .invert_colors = 0,        // Unknown display uses normal colors
            .hardware_mirroring = 0    // Unknown display has no mirroring
        }
    },

    // DISPLAY_TYPE_DUMMY_640x480 - Large projector/dummy display (limited fonts due to memory)
    [DISPLAY_TYPE_DUMMY_640x480] = {
        .type = DISPLAY_TYPE_DUMMY_640x480,
        .name = "Dummy Display 640x480",
        .width = 640, .height = 480,
        .layout = {
            .margin_left = 100, .margin_top = 100, .padding = 10, .border_width = 2,
            .usable_width = 440, .usable_height = 200
        },
        .fonts = {
            .primary = &lv_font_montserrat_14,    // Use 14 instead of 24 (not available)
            .secondary = &lv_font_montserrat_12,  // Use 12 instead of 18 (not available)
            .large = &lv_font_montserrat_14,      // Use 14 instead of 48 (not available)
            .cjk = &lv_font_montserrat_48,       
            .line_spacing = 3
        },
        .patterns = {
            .chess_square_size = 40, .bar_thickness = 20, .scroll_speed = 5
        },
        .performance = {
            .refresh_rate_ms = 16, .animation_enabled = 1, .max_text_length = 512
        },
        .color_config = {
            .invert_colors = 0,        // Dummy display uses normal colors
            .hardware_mirroring = 0    // Dummy display has no mirroring
        }
    },

    // DISPLAY_TYPE_SSD1306_128x64 - Small OLED display
    [DISPLAY_TYPE_SSD1306_128x64] = {
        .type = DISPLAY_TYPE_SSD1306_128x64,
        .name = "SSD1306 OLED 128x64",
        .width = 128, .height = 64,
        .layout = {
            .margin_left = 2, .margin_top = 2, .padding = 2, .border_width = 1,
            .usable_width = 124, .usable_height = 60
        },
        .fonts = {
            .primary = &lv_font_montserrat_12,
            .secondary = &lv_font_montserrat_12,  // Use 12 instead of 10 (not available)
            .large = &lv_font_montserrat_14,
            .cjk = &lv_font_montserrat_48,
            .line_spacing = 1
        },
        .patterns = {
            .chess_square_size = 8, .bar_thickness = 4, .scroll_speed = 2
        },
        .performance = {
            .refresh_rate_ms = 16, .animation_enabled = 1, .max_text_length = 128
        },
        .color_config = {
            .invert_colors = 0,        // SSD1306 works correctly, no inversion needed
            .hardware_mirroring = 0    // SSD1306 displays correctly, no mirroring
        }
    },

    // DISPLAY_TYPE_A6N_640x480 - Future A6N projector (limited fonts due to memory)
    [DISPLAY_TYPE_A6N_640x480] = {
        .type = DISPLAY_TYPE_A6N_640x480,
        .name = "A6N Projector 640x480", 
        .width = 640, .height = 480,
        .layout = {
            .margin_left = 80, .margin_top = 80, .padding = 8, .border_width = 2,
            .usable_width = 480, .usable_height = 320
        },
        .fonts = {
            .primary = &lv_font_montserrat_14,    // Use 14 instead of 30 (not available)
            .secondary = &lv_font_montserrat_18,  // Use 18 for secondary text
            // .secondary = &lv_font_simsun_16_cjk,  // Use 18 for secondary text
            .large = &lv_font_montserrat_48,      // Use 14 instead of 48 (not available)
            .cjk = &lv_font_montserrat_48,        // Only CJK font available
            .line_spacing = 4
        },
        .patterns = {
            .chess_square_size = 32, .bar_thickness = 16, .scroll_speed = 4
        },
        .performance = {
            .refresh_rate_ms = 16, .animation_enabled = 1, .max_text_length = 512
        },
        .color_config = {
            .invert_colors = 1,        // A6N needs color inversion (text LEDs off -> on)
            .hardware_mirroring = 1    // A6N has mirrored output that needs correction
        }
    }
};

display_type_t display_detect_type(const char* device_name)
{
    if (!device_name)
    {
        return DISPLAY_TYPE_UNKNOWN;
    }

    // Detect based on device tree compatible strings or device names
    if (strstr(device_name, "ssd1306") || strstr(device_name, "solomon,ssd1306fb"))
    {
        LOG_INF("Detected SSD1306 OLED display");
        return DISPLAY_TYPE_SSD1306_128x64;
    }

    if (strstr(device_name, "dummy") || strstr(device_name, "zephyr,dummy-display"))
    {
        LOG_INF("Detected dummy display - using large layout");
        return DISPLAY_TYPE_DUMMY_640x480;
    }

    if (strstr(device_name, "a6n"))
    {
        LOG_INF("Detected A6N projector display");
        return DISPLAY_TYPE_A6N_640x480;
    }

    LOG_WRN("Unknown display type: %s, using default configuration", device_name);
    return DISPLAY_TYPE_UNKNOWN;
}

int display_config_init(void)
{
    if (config_initialized)
    {
        return 0;
    }

    // Get the chosen display device from device tree
    const struct device* display_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_display));

    if (!device_is_ready(display_dev))
    {
        LOG_ERR("Display device not ready");
        return -ENODEV;
    }

    // Get device name for type detection
    const char* device_name = display_dev->name;
    LOG_INF("Initializing display config for device: %s", device_name);

    // Detect display type
    display_type_t detected_type = display_detect_type(device_name);

// Also check device tree compatible for additional detection
#if DT_NODE_EXISTS(DT_CHOSEN(zephyr_display))
    const char* compatible = DT_PROP_OR(DT_CHOSEN(zephyr_display), compatible, "unknown");
    if (detected_type == DISPLAY_TYPE_UNKNOWN)
    {
        detected_type = display_detect_type(compatible);
    }
#endif

    // Copy appropriate configuration
    if (detected_type < DISPLAY_TYPE_MAX)
    {
        memcpy(&current_config, &display_configs[detected_type], sizeof(display_config_t));
        LOG_INF("Loaded configuration for %s (%dx%d)", current_config.name, current_config.width,
                current_config.height);
    }
    else
    {
        // Fallback to unknown/default configuration
        memcpy(&current_config, &display_configs[DISPLAY_TYPE_UNKNOWN], sizeof(display_config_t));
        LOG_WRN("Using default display configuration");
    }

    config_initialized = true;
    return 0;
}

const display_config_t* display_get_config(void)
{
    if (!config_initialized)
    {
        LOG_WRN("Display config not initialized, calling display_config_init()");
        display_config_init();
    }

    return &current_config;
}

int display_apply_container_config(lv_obj_t* container, lv_obj_t* parent, const display_config_t* config)
{
    if (!container || !config)
    {
        return -EINVAL;
    }

    // Apply layout configuration
    lv_obj_set_size(container, config->layout.usable_width, config->layout.usable_height);
    lv_obj_set_pos(container, config->layout.margin_left, config->layout.margin_top);

    // Apply styling
    lv_obj_set_style_border_width(container, config->layout.border_width, 0);
    lv_obj_set_style_pad_all(container, config->layout.padding, 0);

    LOG_DBG("Applied container config: %dx%d at (%d,%d), border=%d, padding=%d",
            config->layout.usable_width, config->layout.usable_height,
            config->layout.margin_left, config->layout.margin_top,
            config->layout.border_width, config->layout.padding);

    return 0;
}

const lv_font_t* display_get_font(const char* text_type)
{
    const display_config_t* config = display_get_config();

    if (!text_type)
    {
        return config->fonts.primary;
    }

    if (strcmp(text_type, "primary") == 0)
    {
        return config->fonts.primary;
    }
    else if (strcmp(text_type, "secondary") == 0)
    {
        return config->fonts.secondary;
    }
    else if (strcmp(text_type, "large") == 0)
    {
        return config->fonts.large;
    }
    else if (strcmp(text_type, "cjk") == 0)
    {
        return config->fonts.secondary;
    }

    // Default fallback
    return config->fonts.primary;
}

void display_calculate_container_dimensions(uint16_t* width, uint16_t* height, uint16_t* x, uint16_t* y)
{
    const display_config_t *config = display_get_config();
    
    if (width) *width = config->layout.usable_width;
    if (height) *height = config->layout.usable_height;
    if (x) *x = config->layout.margin_left;
    if (y) *y = config->layout.margin_top;
}

lv_color_t display_get_text_color(void)
{
    const display_config_t* config = display_get_config();

    if (config->color_config.invert_colors)
    {
        // For A6N: invert to make text LEDs turn ON
        return lv_color_black();
    }
    else
    {
        // For SSD1306 and normal displays: white text
        return lv_color_white();
    }
}

lv_color_t display_get_background_color(void)
{
    const display_config_t* config = display_get_config();

    if (config->color_config.invert_colors)
    {
        // For A6N: invert to make background LEDs turn OFF
        return lv_color_white();
    }
    else
    {
        // For SSD1306 and normal displays: black background
        return lv_color_black();
    }
}

lv_color_t display_get_adjusted_color(lv_color_t color)
{
    const display_config_t* config = display_get_config();

    if (config && config->color_config.invert_colors)
    {
        // For color inversion, swap white and black
        lv_color32_t color32 = lv_color_to_32(color, LV_OPA_COVER);
        lv_color32_t white32 = lv_color_to_32(lv_color_white(), LV_OPA_COVER);
        lv_color32_t black32 = lv_color_to_32(lv_color_black(), LV_OPA_COVER);

        if (lv_color32_eq(color32, white32))
        {
            return lv_color_black();
        }
        else if (lv_color32_eq(color32, black32))
        {
            return lv_color_white();
        }
    }

    return color;
}