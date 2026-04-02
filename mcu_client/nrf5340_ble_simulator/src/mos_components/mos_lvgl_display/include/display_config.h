/*** 
 * @Author       : Cole
 * @Date         : 2026-01-17 15:30:32
 * @LastEditTime : 2026-01-29 14:16:25
 * @FilePath     : display_config.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2026 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef DISPLAY_CONFIG_H
#define DISPLAY_CONFIG_H

#include <lvgl.h>
#include <zephyr/device.h>

/**
 * @brief Display types supported by the modular configuration system
 */
typedef enum {
    DISPLAY_TYPE_UNKNOWN = 0,
    DISPLAY_TYPE_DUMMY_640x480,    // Large projector/dummy display 640x480
    DISPLAY_TYPE_SSD1306_128x64,   // Small OLED display 128x64
    DISPLAY_TYPE_A6N_640x480, // Future: A6N projector 640x480
    DISPLAY_TYPE_MAX
} display_type_t;

/**
 * @brief Display configuration structure containing all adaptive parameters
 */
typedef struct {
    // Display identification
    display_type_t type;
    const char *name;
    
    // Physical dimensions
    uint16_t width;
    uint16_t height;
    
    // Container layout configuration
    struct {
        uint16_t margin_left;         // Margin from left edge
        uint16_t margin_top;          // Margin from top edge
        uint16_t padding;             // Internal container padding
        uint16_t border_width;        // Border thickness
        uint16_t usable_width;        // Available content width
        uint16_t usable_height;       // Available content height
    } layout;
    
    // Font configuration
    struct {
        const lv_font_t *primary;     // Main text font
        const lv_font_t *secondary;   // Secondary/smaller font
        const lv_font_t *large;       // Large heading font
        const lv_font_t *cjk;         // Chinese/Japanese/Korean font (if available)
        uint8_t line_spacing;         // Line spacing between text lines
    } fonts;
    
    // Pattern sizing for test patterns
    struct {
        uint16_t chess_square_size;   // Chess pattern square size
        uint16_t bar_thickness;       // Horizontal/vertical bar thickness
        uint16_t scroll_speed;        // Scrolling animation speed
    } patterns;
    
    // Performance optimization
    struct {
        uint16_t refresh_rate_ms;     // Display refresh interval
        uint8_t animation_enabled;    // Enable/disable animations for performance
        uint16_t max_text_length;     // Maximum text length for this display
    } performance;
    
    // Color configuration for display-specific handling
    struct {
        uint8_t invert_colors;        // Invert black/white colors (for A6N)
        uint8_t hardware_mirroring;   // Hardware-level mirroring compensation
    } color_config;
    
} display_config_t;

/**
 * @brief Get the current display configuration based on active display device
 * @return Pointer to active display configuration structure
 */
const display_config_t* display_get_config(void);

/**
 * @brief Initialize display configuration system and detect active display
 * @return 0 on success, negative error code on failure
 */
int display_config_init(void);

/**
 * @brief Get display type from device tree compatible string
 * @param device_name Device name or compatible string
 * @return Detected display type
 */
display_type_t display_detect_type(const char *device_name);

/**
 * @brief Apply display configuration to LVGL container
 * @param container LVGL container object to configure
 * @param parent Parent screen object
 * @param config Display configuration to apply
 * @return 0 on success, negative error code on failure
 */
int display_apply_container_config(lv_obj_t *container, lv_obj_t *parent, const display_config_t *config);

/**
 * @brief Get appropriate font for the current display and text type
 * @param text_type Type of text (primary, secondary, large, cjk)
 * @return Pointer to appropriate font
 */
const lv_font_t* display_get_font(const char *text_type);

/**
 * @brief Calculate optimal container dimensions for current display
 * @param width Pointer to store calculated width
 * @param height Pointer to store calculated height
 * @param x Pointer to store calculated X position
 * @param y Pointer to store calculated Y position
 */
void display_calculate_container_dimensions(uint16_t *width, uint16_t *height, uint16_t *x, uint16_t *y);

/**
 * @brief Get display-appropriate text color
 * @return LVGL color for text based on current display type
 */
lv_color_t display_get_text_color(void);

/**
 * @brief Get display-appropriate background color  
 * @return LVGL color for background based on current display type
 */
lv_color_t display_get_background_color(void);

/**
 * @brief Apply display-specific color adjustments
 * @param color Original color to adjust
 * @return Adjusted color based on display characteristics
 */
lv_color_t display_get_adjusted_color(lv_color_t color);

#endif /* DISPLAY_CONFIG_H */