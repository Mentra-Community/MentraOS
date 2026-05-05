#include "color_utils.h"

lv_color_t mos_color_from_rgb565(uint32_t color)
{
    uint16_t c = (uint16_t)color;
    uint8_t r = (c >> 11) & 0x1F;
    uint8_t g = (c >> 5) & 0x3F;
    uint8_t b = c & 0x1F;
    return lv_color_make((uint8_t)((r * 255U) / 31U), (uint8_t)((g * 255U) / 63U), (uint8_t)((b * 255U) / 31U));
}
