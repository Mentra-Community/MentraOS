#ifndef EXTERNAL_FONTS_CONFIG_H
#define EXTERNAL_FONTS_CONFIG_H

/**
 * @file external_fonts_config.h
 * @brief XIP font configuration for external QSPI flash placement
 * 
 * This configuration uses Nordic's partition manager XIP support to place
 * font data in external QSPI flash that can be accessed directly by the CPU.
 * No custom linker sections needed - partition manager handles XIP mapping.
 */

// For Nordic Connect SDK with partition manager XIP support,
// fonts in external flash are automatically accessible.
// No special section attributes needed - partition manager maps external flash.
#ifdef LV_ATTRIBUTE_LARGE_CONST
#undef LV_ATTRIBUTE_LARGE_CONST  
#endif
#define LV_ATTRIBUTE_LARGE_CONST

// Font declarations
#include "font_puhui_24_1.h"

#endif /* EXTERNAL_FONTS_CONFIG_H */