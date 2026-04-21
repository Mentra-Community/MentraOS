#ifndef MOS_TOUCH_APP_H_
#define MOS_TOUCH_APP_H_

#include <stdbool.h>
#include <stdint.h>

#include "mos_iqs7211a.h"

/* ---------------------------- Touch Policy / Tuning ----------------------------
 * These macros are app-layer policy knobs (not driver-layer registers).
 * They define the profile written by mos_touch_app_init() to IQS blocks:
 *   0x40 Report rates / timing
 *   0x50 System settings
 *   0x60 Trackpad settings
 *   0x70 ALP / filter settings
 *   0x80 Gesture tuning
 *   0x90 RxTx mapping
 *   0xA0 Cycle allocation
 */

/* Helpers for splitting 16-bit words to little-endian bytes for block writes. */
#define MOS_TOUCH_U16_LO(v) ((uint8_t)((uint16_t)(v) & 0x00FFu))
#define MOS_TOUCH_U16_HI(v) ((uint8_t)(((uint16_t)(v) >> 8) & 0x00FFu))

/* 0x60 block: trackpad behavior/profile (resolution/filter/trim-related words). */
#define MOS_TOUCH_CFG60_WORD0 0x0328u
#define MOS_TOUCH_CFG60_WORD1 0x0103u
#define MOS_TOUCH_CFG60_WORD2 0x0200u
#define MOS_TOUCH_CFG60_WORD3 0x0200u
#define MOS_TOUCH_CFG60_WORD4 0x0006u
#define MOS_TOUCH_CFG60_WORD5 0x007Cu
#define MOS_TOUCH_CFG60_WORD6 0x8007u
#define MOS_TOUCH_CFG60_WORD7 0x0314u
#define MOS_TOUCH_CFG60_WORD8 0x0023u
#define MOS_TOUCH_CFG60_WORD9 0x0023u

/* 0x70 block: ALP/filter beta tuning. */
#define MOS_TOUCH_CFG70_WORD0 0x00B4u
#define MOS_TOUCH_CFG70_WORD1 0x0406u
#define MOS_TOUCH_CFG70_WORD2 0x0321u
#define MOS_TOUCH_CFG70_WORD3 0x0A00u
#define MOS_TOUCH_CFG70_WORD4 0x0002u

/* 0x30~0x39 block: ATI related tuning (aligned with IQS7211A_init.h export). */
#define MOS_TOUCH_CFG30_WORD0 0x29E1u
#define MOS_TOUCH_CFG30_WORD1 0x000Au
#define MOS_TOUCH_CFG30_WORD2 0x012Cu
#define MOS_TOUCH_CFG30_WORD3 0x001Eu
#define MOS_TOUCH_CFG30_WORD4 0x001Eu
#define MOS_TOUCH_CFG30_WORD5 0x0005u
#define MOS_TOUCH_CFG30_WORD6 0x27E1u
#define MOS_TOUCH_CFG30_WORD7 0x0007u
#define MOS_TOUCH_CFG30_WORD8 0x00C8u
#define MOS_TOUCH_CFG30_WORD9 0x0014u

/* 0x3A~0x3B block: ALP ATI compensation A/B. */
#define MOS_TOUCH_CFG3A_WORD0 0x0214u
#define MOS_TOUCH_CFG3A_WORD1 0x021Cu

/* 0x40 block: report rates and timing. */
#define MOS_TOUCH_CFG40_WORD0 0x000Au
#define MOS_TOUCH_CFG40_WORD1 0x0032u
#define MOS_TOUCH_CFG40_WORD2 0x0032u
#define MOS_TOUCH_CFG40_WORD3 0x0032u
#define MOS_TOUCH_CFG40_WORD4 0x0064u
#define MOS_TOUCH_CFG40_WORD5 0x000Au
#define MOS_TOUCH_CFG40_WORD6 0x003Cu
#define MOS_TOUCH_CFG40_WORD7 0x0014u
#define MOS_TOUCH_CFG40_WORD8 0x000Au
#define MOS_TOUCH_CFG40_WORD9 0x0008u
#define MOS_TOUCH_CFG40_WORD10 0x0064u

/* 0x50 block: system control and thresholds. */
#define MOS_TOUCH_CFG50_WORD0 0x0000u
#define MOS_TOUCH_CFG50_WORD1 0x063Cu
#define MOS_TOUCH_CFG50_WORD2 0xFF20u
#define MOS_TOUCH_CFG50_WORD3 0x181Eu
#define MOS_TOUCH_CFG50_WORD4 0x0008u
#define MOS_TOUCH_CFG50_WORD5 0xFFFFu
#define MOS_TOUCH_CFG50_WORD6 0x0402u
#define MOS_TOUCH_CFG50_WORD7 0xFFFFu
#define MOS_TOUCH_CFG50_WORD8 0x1A02u
#define MOS_TOUCH_CFG50_WORD9 0x1A02u
#define MOS_TOUCH_CFG50_WORD10 0x0D01u
#define MOS_TOUCH_CFG50_WORD11 0x1D65u

/* 0x80 block: gesture tuning (units follow Azoteq profile conventions). */
#ifndef MOS_TOUCH_GESTURE_ENABLE_WORD
#define MOS_TOUCH_GESTURE_ENABLE_WORD 0x0F3Fu
#endif
#ifndef MOS_TOUCH_TAP_TIME_MS
#define MOS_TOUCH_TAP_TIME_MS 150u
#endif
#ifndef MOS_TOUCH_TAP_DISTANCE
#define MOS_TOUCH_TAP_DISTANCE 50u
#endif
#ifndef MOS_TOUCH_HOLD_TIME_MS
#define MOS_TOUCH_HOLD_TIME_MS 300u
#endif
#ifndef MOS_TOUCH_SWIPE_TIME_MS
#define MOS_TOUCH_SWIPE_TIME_MS 150u
#endif
#ifndef MOS_TOUCH_SWIPE_ANGLE
#define MOS_TOUCH_SWIPE_ANGLE 23u
#endif
#ifndef MOS_TOUCH_SWIPE_INITIAL_X_DISTANCE
#define MOS_TOUCH_SWIPE_INITIAL_X_DISTANCE 200u
#endif
#ifndef MOS_TOUCH_SWIPE_INITIAL_Y_DISTANCE
#define MOS_TOUCH_SWIPE_INITIAL_Y_DISTANCE 200u
#endif

/* 0x90 block: RxTx mapping bytes. */
#define MOS_TOUCH_CFG90_B0 0x05u
#define MOS_TOUCH_CFG90_B1 0x03u
#define MOS_TOUCH_CFG90_B2 0x00u
#define MOS_TOUCH_CFG90_B3 0x09u
#define MOS_TOUCH_CFG90_B4 0x0Au
#define MOS_TOUCH_CFG90_B5 0x0Bu
#define MOS_TOUCH_CFG90_B6 0x08u
#define MOS_TOUCH_CFG90_B7 0x07u
#define MOS_TOUCH_CFG90_B8 0x03u
#define MOS_TOUCH_CFG90_B9 0x09u
#define MOS_TOUCH_CFG90_B10 0x0Au
#define MOS_TOUCH_CFG90_B11 0x00u
#define MOS_TOUCH_CFG90_B12 0x00u

/* 0xA0 block: cycle setup 0..9. */
#define MOS_TOUCH_CFGA0_B0 0x05u
#define MOS_TOUCH_CFGA0_B1 0x02u
#define MOS_TOUCH_CFGA0_B2 0x00u
#define MOS_TOUCH_CFGA0_B3 0x05u
#define MOS_TOUCH_CFGA0_B4 0xFFu
#define MOS_TOUCH_CFGA0_B5 0x01u
#define MOS_TOUCH_CFGA0_B6 0x05u
#define MOS_TOUCH_CFGA0_B7 0x05u
#define MOS_TOUCH_CFGA0_B8 0x03u
#define MOS_TOUCH_CFGA0_B9 0x05u
#define MOS_TOUCH_CFGA0_B10 0xFFu
#define MOS_TOUCH_CFGA0_B11 0x04u
#define MOS_TOUCH_CFGA0_B12 0x05u
#define MOS_TOUCH_CFGA0_B13 0x08u
#define MOS_TOUCH_CFGA0_B14 0x06u
#define MOS_TOUCH_CFGA0_B15 0x05u
#define MOS_TOUCH_CFGA0_B16 0xFFu
#define MOS_TOUCH_CFGA0_B17 0x07u
#define MOS_TOUCH_CFGA0_B18 0x05u
#define MOS_TOUCH_CFGA0_B19 0xFFu
#define MOS_TOUCH_CFGA0_B20 0xFFu
#define MOS_TOUCH_CFGA0_B21 0x05u
#define MOS_TOUCH_CFGA0_B22 0xFFu
#define MOS_TOUCH_CFGA0_B23 0xFFu
#define MOS_TOUCH_CFGA0_B24 0x05u
#define MOS_TOUCH_CFGA0_B25 0xFFu
#define MOS_TOUCH_CFGA0_B26 0xFFu
#define MOS_TOUCH_CFGA0_B27 0x05u
#define MOS_TOUCH_CFGA0_B28 0xFFu
#define MOS_TOUCH_CFGA0_B29 0xFFu

/* 0xB0 block: cycle setup 10..17. */
#define MOS_TOUCH_CFGB0_B0 0x05u
#define MOS_TOUCH_CFGB0_B1 0xFFu
#define MOS_TOUCH_CFGB0_B2 0xFFu
#define MOS_TOUCH_CFGB0_B3 0x05u
#define MOS_TOUCH_CFGB0_B4 0xFFu
#define MOS_TOUCH_CFGB0_B5 0xFFu
#define MOS_TOUCH_CFGB0_B6 0x05u
#define MOS_TOUCH_CFGB0_B7 0xFFu
#define MOS_TOUCH_CFGB0_B8 0xFFu
#define MOS_TOUCH_CFGB0_B9 0x05u
#define MOS_TOUCH_CFGB0_B10 0xFFu
#define MOS_TOUCH_CFGB0_B11 0xFFu
#define MOS_TOUCH_CFGB0_B12 0x05u
#define MOS_TOUCH_CFGB0_B13 0xFFu
#define MOS_TOUCH_CFGB0_B14 0xFFu
#define MOS_TOUCH_CFGB0_B15 0x05u
#define MOS_TOUCH_CFGB0_B16 0xFFu
#define MOS_TOUCH_CFGB0_B17 0xFFu
#define MOS_TOUCH_CFGB0_B18 0x05u
#define MOS_TOUCH_CFGB0_B19 0xFFu
#define MOS_TOUCH_CFGB0_B20 0xFFu
#define MOS_TOUCH_CFGB0_B21 0x05u
#define MOS_TOUCH_CFGB0_B22 0xFFu
#define MOS_TOUCH_CFGB0_B23 0xFFu


int mos_touch_app_init(void);

int mos_touch_app_get_resolved_gesture(mos_iqs7211a_slide_direction_t *out_dir, bool *out_valid,
                                       uint8_t *out_confidence);

int mos_touch_app_get_last_final_gesture_event(mos_iqs7211a_slide_direction_t *out_dir, bool *out_valid,
                                               uint8_t *out_confidence, uint32_t *out_sequence);

#endif  // MOS_TOUCH_APP_H_
