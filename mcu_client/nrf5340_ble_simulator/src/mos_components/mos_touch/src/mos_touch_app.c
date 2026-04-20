/*
 * @Author       : Cole
 * @Date         : 2026-03-31 14:10:00
 * @LastEditTime : 2026-04-02 10:09:21
 * @FilePath     : mos_touch_app.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2026
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_touch_app.h"

#include <errno.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>
#include <zephyr/sys/util.h>

LOG_MODULE_REGISTER(mos_touch_app, LOG_LEVEL_INF);

#define MOS_TOUCH_IQS_INFO_ATI_ERROR_BIT BIT(3)
#define MOS_TOUCH_IQS_INFO_RE_ATI_OCCURRED_BIT BIT(4)
#define MOS_TOUCH_IQS_INFO_SHOW_RESET_BIT BIT(7)
#define MOS_TOUCH_IQS_SYSTEM_ACK_RESET_MASK 0x0080u
#define MOS_TOUCH_IQS_SYSTEM_RE_ATI_MASK 0x0020u
#define MOS_TOUCH_IQS_CONFIG_EVENT_MODE_MASK 0x0100u
#define MOS_TOUCH_ATI_WAIT_POLL_MS 20
#define MOS_TOUCH_ATI_WAIT_TIMEOUT_MS 2000

// 主轴累计距离最小阈值
#define MOS_TOUCH_RESOLVE_MIN_TRAVEL 50

/*
 * Resolve slide direction with configurable dominance ratio thresholds (e.g. 3:2) to reduce ambiguous classifications.
 * 使用可配置的主导比率阈值（例如3:2）来判定滑动方向，减少模糊分类*/
#define MOS_TOUCH_RESOLVE_X_DOM_RATIO_NUM 3
#define MOS_TOUCH_RESOLVE_X_DOM_RATIO_DEN 2
#define MOS_TOUCH_RESOLVE_Y_DOM_RATIO_NUM 3
#define MOS_TOUCH_RESOLVE_Y_DOM_RATIO_DEN 2

/* If chip swipe axis conflicts with stroke dominant axis by >=2x, trust stroke axis.
 * 如果芯片滑动轴与笔画主导轴冲突 >=2x，则信任笔画轴*/
#define MOS_TOUCH_CHIP_AXIS_OVERRIDE_RATIO_NUM 2
#define MOS_TOUCH_CHIP_AXIS_OVERRIDE_RATIO_DEN 1

/* Guardrail for glitch frames: reject sudden teleport-like finger jumps in one sample.
 * 防止故障帧：拒绝单个样本中突然的瞬移式手指跳跃*/
#define MOS_TOUCH_MAX_STEP_DELTA 220
/* Ignore saturated/boundary samples that frequently appear around lift/window edges.
忽略在抬起/窗口边缘频繁出现的饱和/边界样本*/
#define MOS_TOUCH_EDGE_Y_MAX 0x03F0u
#define MOS_TOUCH_EDGE_REL_Y_GLITCH 0x0201u
/* Require a few consecutive invalid frames before closing a touch stroke.
要求在关闭触摸笔画之前，需要几个连续的无效帧*/
#define MOS_TOUCH_RELEASE_INVALID_FRAMES 3u

static struct k_spinlock s_touch_app_lock;
static bool s_touch_prev_finger_valid = false;
static uint16_t s_touch_prev_f1x = 0xFFFFu;
static uint16_t s_touch_prev_f1y = 0xFFFFu;
static int32_t s_touch_stroke_dx = 0;
static int32_t s_touch_stroke_dy = 0;
static bool s_touch_has_final = false;
static mos_iqs7211a_slide_direction_t s_touch_final_best_dir = MOS_IQS7211A_SLIDE_NONE;
static uint8_t s_touch_final_best_conf = 0;
static uint8_t s_touch_invalid_streak = 0;
static mos_iqs7211a_slide_direction_t s_touch_current_dir = MOS_IQS7211A_SLIDE_NONE;
static bool s_touch_current_valid = false;
static uint8_t s_touch_current_conf = 0;
static mos_iqs7211a_slide_direction_t s_touch_last_event_dir = MOS_IQS7211A_SLIDE_NONE;
static bool s_touch_last_event_valid = false;
static uint8_t s_touch_last_event_conf = 0;
static uint32_t s_touch_last_event_seq = 0;

static int mos_touch_app_apply_balanced_profile(void)
{
    static const uint8_t blk_0x40[] = {
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD0),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD0),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD1),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD1),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD2),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD2),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD3),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD3),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD4),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD4),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD5),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD5),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD6),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD6),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD7),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD7),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD8),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD8),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD9),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD9),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG40_WORD10), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG40_WORD10),
    };
    static const uint8_t blk_0x50[] = {
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD0),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD0),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD1),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD1),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD2),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD2),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD3),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD3),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD4),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD4),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD5),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD5),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD6),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD6),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD7),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD7),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD8),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD8),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD9),  MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD9),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD10), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD10),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG50_WORD11), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG50_WORD11),
    };
    static const uint8_t blk_0x30[] = {
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD0), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD0),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD1), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD1),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD2), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD2),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD3), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD3),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD4), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD4),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD5), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD5),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD6), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD6),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD7), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD7),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD8), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD8),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG30_WORD9), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG30_WORD9),
    };
    static const uint8_t blk_0x3A[] = {
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG3A_WORD0),
        MOS_TOUCH_U16_HI(MOS_TOUCH_CFG3A_WORD0),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG3A_WORD1),
        MOS_TOUCH_U16_HI(MOS_TOUCH_CFG3A_WORD1),
    };

    static const uint8_t blk_0x60[] = {
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD0), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD0),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD1), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD1),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD2), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD2),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD3), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD3),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD4), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD4),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD5), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD5),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD6), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD6),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD7), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD7),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD8), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD8),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG60_WORD9), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG60_WORD9),
    };
    static const uint8_t blk_0x70[] = {
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG70_WORD0), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG70_WORD0),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG70_WORD1), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG70_WORD1),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG70_WORD2), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG70_WORD2),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG70_WORD3), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG70_WORD3),
        MOS_TOUCH_U16_LO(MOS_TOUCH_CFG70_WORD4), MOS_TOUCH_U16_HI(MOS_TOUCH_CFG70_WORD4),
    };
    static const uint8_t blk_0x80[] = {
        /* 0x80 GESTURE_ENABLE */
        MOS_TOUCH_U16_LO(MOS_TOUCH_GESTURE_ENABLE_WORD),
        MOS_TOUCH_U16_HI(MOS_TOUCH_GESTURE_ENABLE_WORD),
        /* 0x82 TAP_TIME */
        MOS_TOUCH_U16_LO(MOS_TOUCH_TAP_TIME_MS),
        MOS_TOUCH_U16_HI(MOS_TOUCH_TAP_TIME_MS),
        /* 0x84 TAP_DISTANCE */
        MOS_TOUCH_U16_LO(MOS_TOUCH_TAP_DISTANCE),
        MOS_TOUCH_U16_HI(MOS_TOUCH_TAP_DISTANCE),
        /* 0x86 HOLD_TIME */
        MOS_TOUCH_U16_LO(MOS_TOUCH_HOLD_TIME_MS),
        MOS_TOUCH_U16_HI(MOS_TOUCH_HOLD_TIME_MS),
        /* 0x88 SWIPE_TIME */
        MOS_TOUCH_U16_LO(MOS_TOUCH_SWIPE_TIME_MS),
        MOS_TOUCH_U16_HI(MOS_TOUCH_SWIPE_TIME_MS),
        /* 0x8A SWIPE_X_DISTANCE */
        MOS_TOUCH_U16_LO(MOS_TOUCH_SWIPE_INITIAL_X_DISTANCE),
        MOS_TOUCH_U16_HI(MOS_TOUCH_SWIPE_INITIAL_X_DISTANCE),
        /* 0x8C SWIPE_Y_DISTANCE */
        MOS_TOUCH_U16_LO(MOS_TOUCH_SWIPE_INITIAL_Y_DISTANCE),
        MOS_TOUCH_U16_HI(MOS_TOUCH_SWIPE_INITIAL_Y_DISTANCE),
        /* 0x8E SWIPE_ANGLE + 0x8F GESTURE_OPEN */
        MOS_TOUCH_U16_LO(MOS_TOUCH_SWIPE_ANGLE),
        0x00u,
    };
    static const uint8_t blk_0x90[] = {
        MOS_TOUCH_CFG90_B0,  MOS_TOUCH_CFG90_B1,  MOS_TOUCH_CFG90_B2,  MOS_TOUCH_CFG90_B3, MOS_TOUCH_CFG90_B4,
        MOS_TOUCH_CFG90_B5,  MOS_TOUCH_CFG90_B6,  MOS_TOUCH_CFG90_B7,  MOS_TOUCH_CFG90_B8, MOS_TOUCH_CFG90_B9,
        MOS_TOUCH_CFG90_B10, MOS_TOUCH_CFG90_B11, MOS_TOUCH_CFG90_B12,
    };
    static const uint8_t blk_0xA0[] = {
        MOS_TOUCH_CFGA0_B0,  MOS_TOUCH_CFGA0_B1,  MOS_TOUCH_CFGA0_B2,  MOS_TOUCH_CFGA0_B3,  MOS_TOUCH_CFGA0_B4,
        MOS_TOUCH_CFGA0_B5,  MOS_TOUCH_CFGA0_B6,  MOS_TOUCH_CFGA0_B7,  MOS_TOUCH_CFGA0_B8,  MOS_TOUCH_CFGA0_B9,
        MOS_TOUCH_CFGA0_B10, MOS_TOUCH_CFGA0_B11, MOS_TOUCH_CFGA0_B12, MOS_TOUCH_CFGA0_B13, MOS_TOUCH_CFGA0_B14,
        MOS_TOUCH_CFGA0_B15, MOS_TOUCH_CFGA0_B16, MOS_TOUCH_CFGA0_B17, MOS_TOUCH_CFGA0_B18, MOS_TOUCH_CFGA0_B19,
        MOS_TOUCH_CFGA0_B20, MOS_TOUCH_CFGA0_B21, MOS_TOUCH_CFGA0_B22, MOS_TOUCH_CFGA0_B23, MOS_TOUCH_CFGA0_B24,
        MOS_TOUCH_CFGA0_B25, MOS_TOUCH_CFGA0_B26, MOS_TOUCH_CFGA0_B27, MOS_TOUCH_CFGA0_B28, MOS_TOUCH_CFGA0_B29,
    };
    static const uint8_t blk_0xB0[] = {
        MOS_TOUCH_CFGB0_B0,  MOS_TOUCH_CFGB0_B1,  MOS_TOUCH_CFGB0_B2,  MOS_TOUCH_CFGB0_B3,  MOS_TOUCH_CFGB0_B4,
        MOS_TOUCH_CFGB0_B5,  MOS_TOUCH_CFGB0_B6,  MOS_TOUCH_CFGB0_B7,  MOS_TOUCH_CFGB0_B8,  MOS_TOUCH_CFGB0_B9,
        MOS_TOUCH_CFGB0_B10, MOS_TOUCH_CFGB0_B11, MOS_TOUCH_CFGB0_B12, MOS_TOUCH_CFGB0_B13, MOS_TOUCH_CFGB0_B14,
        MOS_TOUCH_CFGB0_B15, MOS_TOUCH_CFGB0_B16, MOS_TOUCH_CFGB0_B17, MOS_TOUCH_CFGB0_B18, MOS_TOUCH_CFGB0_B19,
        MOS_TOUCH_CFGB0_B20, MOS_TOUCH_CFGB0_B21, MOS_TOUCH_CFGB0_B22, MOS_TOUCH_CFGB0_B23,
    };

    struct block
    {
        uint8_t start;
        const uint8_t *data;
        size_t len;
    };
    static const struct block blocks[] = {
        {0x40, blk_0x40, sizeof(blk_0x40)}, {0x50, blk_0x50, sizeof(blk_0x50)}, {0x30, blk_0x30, sizeof(blk_0x30)},
        {0x3A, blk_0x3A, sizeof(blk_0x3A)}, {0x60, blk_0x60, sizeof(blk_0x60)}, {0x70, blk_0x70, sizeof(blk_0x70)},
        {0x80, blk_0x80, sizeof(blk_0x80)}, {0x90, blk_0x90, sizeof(blk_0x90)}, {0xA0, blk_0xA0, sizeof(blk_0xA0)},
        {0xB0, blk_0xB0, sizeof(blk_0xB0)},
    };

    for (size_t i = 0; i < ARRAY_SIZE(blocks); i++)
    {
        int ret = mos_iqs7211a_write_block8(blocks[i].start, blocks[i].data, blocks[i].len);
        if (ret != 0)
        {
            LOG_ERR("Touch profile block 0x%02x write failed: %d", blocks[i].start, ret);
            return ret;
        }
    }

    LOG_INF("Touch profile applied (0x30/0x3A/0x40/0x50/0x60/0x70/0x80/0x90/0xA0/0xB0)");
    return 0;
}

static int mos_touch_app_finalize_profile_load(void)
{
    int ret = mos_iqs7211a_update_reg16(IQS7211A_REG_SYSTEM_CONTROL, MOS_TOUCH_IQS_SYSTEM_ACK_RESET_MASK,
                                        MOS_TOUCH_IQS_SYSTEM_ACK_RESET_MASK);
    if (ret != 0)
    {
        LOG_ERR("IQS ack reset failed: %d", ret);
        return ret;
    }

    ret = mos_iqs7211a_update_reg16(IQS7211A_REG_SYSTEM_CONTROL, MOS_TOUCH_IQS_SYSTEM_RE_ATI_MASK,
                                    MOS_TOUCH_IQS_SYSTEM_RE_ATI_MASK);
    if (ret != 0)
    {
        LOG_ERR("IQS ReATI request failed: %d", ret);
        return ret;
    }

    for (int elapsed = 0; elapsed < MOS_TOUCH_ATI_WAIT_TIMEOUT_MS; elapsed += MOS_TOUCH_ATI_WAIT_POLL_MS)
    {
        uint16_t info_flags = 0;

        ret = mos_iqs7211a_read_event_states(&info_flags, NULL);
        if ((ret == 0) && ((info_flags & MOS_TOUCH_IQS_INFO_RE_ATI_OCCURRED_BIT) == 0U))
        {
            if ((info_flags & MOS_TOUCH_IQS_INFO_ATI_ERROR_BIT) != 0U)
            {
                LOG_WRN("IQS ATI completed with ATI_ERROR still set (INFO=0x%04x)", info_flags);
            }

            ret = mos_iqs7211a_update_reg16(IQS7211A_REG_CONFIG_SETTINGS, MOS_TOUCH_IQS_CONFIG_EVENT_MODE_MASK,
                                            MOS_TOUCH_IQS_CONFIG_EVENT_MODE_MASK);
            if (ret != 0)
            {
                LOG_ERR("IQS event mode enable failed: %d", ret);
                return ret;
            }

            return 0;
        }

        k_sleep(K_MSEC(MOS_TOUCH_ATI_WAIT_POLL_MS));
    }

    LOG_ERR("IQS ReATI wait timed out");
    return -ETIMEDOUT;
}

static int32_t mos_touch_app_abs32(int32_t value)
{
    return (value < 0) ? -value : value;
}
/**
 * @description: 解析滑动方向
 * @note:
 *   - 如果存在单一明确的滑动事件，则直接使用该事件作为结果，置信度为100；
 *   -
 * 否则根据移动距离和主轴占优条件计算结果，置信度根据主轴与次轴距离差占主轴距离的比例计算，范围0~90，差值越大置信度越高。
 *
 *   Resolve slide direction from state:
 *   - If there is a single clear swipe event, use it directly with confidence=100.
 *   - Otherwise, determine direction by comparing X/Y travel and dominance ratio; confidence is proportional to the
 * difference between major/minor axis (0~90).
 *
 * @param gestures: 来自硬件的手势位 / Gesture bits from hardware
 * @param stroke_dx: X轴累计移动距离 / X-axis travel since last valid position
 * @param stroke_dy: Y轴累计移动距离 / Y-axis travel since last valid position
 * @param out_dir: 输出解析得到的滑动方向 / Output resolved direction
 * @param out_valid: 输出解析结果是否有效 / Output: is result valid
 * @param out_confidence: 输出解析结果的置信度 / Output: result confidence
 * @return 无 / None
 */
static bool mos_touch_app_decode_single_swipe_gesture(uint16_t gestures, mos_iqs7211a_slide_direction_t *out_dir)
{
    uint8_t count = 0;
    mos_iqs7211a_slide_direction_t direction = MOS_IQS7211A_SLIDE_NONE;

    if ((gestures & 0x0004u) != 0U)
    {
        count++;
        direction = MOS_IQS7211A_SLIDE_X_DECREASE;
    }
    if ((gestures & 0x0008u) != 0U)
    {
        count++;
        direction = MOS_IQS7211A_SLIDE_X_INCREASE;
    }
    if ((gestures & 0x0010u) != 0U)
    {
        count++;
        direction = MOS_IQS7211A_SLIDE_Y_INCREASE;
    }
    if ((gestures & 0x0020u) != 0U)
    {
        count++;
        direction = MOS_IQS7211A_SLIDE_Y_DECREASE;
    }

    if (count == 1U)
    {
        *out_dir = direction;
        return true;
    }

    return false;
}
/**
 * @description: 解析滑动方向
 * @note:
 *   - 如果存在单一明确的滑动事件，则直接使用该事件作为结果，置信度为100；
 *   -
 * 否则根据移动距离和主轴占优条件计算结果，置信度根据主轴与次轴距离差占主轴距离的比例计算，范围0~90，差值越大置信度越高。
 *
 *   Resolve slide direction from state:
 *   - If there is a single clear swipe event, use it directly with confidence=100.
 *   - Otherwise, determine direction by comparing X/Y travel and dominance ratio; confidence is proportional to the
 * difference between major/minor axis (0~90).
 *
 * @param gestures: 来自硬件的手势位 / Gesture bits from hardware
 * @param stroke_dx: X轴累计移动距离 / X-axis travel since last valid position
 * @param stroke_dy: Y轴累计移动距离 / Y-axis travel since last valid position
 * @param out_dir: 输出解析得到的滑动方向 / Output resolved direction
 * @param out_valid: 输出解析结果是否有效 / Output: is result valid
 * @param out_confidence: 输出解析结果的置信度 / Output: result confidence
 * @return 无 / None
 */
static void mos_touch_app_resolve_from_state(uint16_t gestures, int32_t stroke_dx, int32_t stroke_dy,
                                             mos_iqs7211a_slide_direction_t *out_dir, bool *out_valid,
                                             uint8_t *out_confidence)
{
    const int32_t abs_x = mos_touch_app_abs32(stroke_dx);
    const int32_t abs_y = mos_touch_app_abs32(stroke_dy);
    const int32_t max_axis = (abs_x > abs_y) ? abs_x : abs_y;
    mos_iqs7211a_slide_direction_t chip_dir = MOS_IQS7211A_SLIDE_NONE;

    *out_dir = MOS_IQS7211A_SLIDE_NONE;
    *out_valid = false;
    *out_confidence = 0U;

    if (mos_touch_app_decode_single_swipe_gesture(gestures, &chip_dir))
    {
        bool chip_axis_conflict = false;
        if ((chip_dir == MOS_IQS7211A_SLIDE_X_INCREASE) || (chip_dir == MOS_IQS7211A_SLIDE_X_DECREASE))
        {
            chip_axis_conflict =
                (abs_y * MOS_TOUCH_CHIP_AXIS_OVERRIDE_RATIO_DEN) >= (abs_x * MOS_TOUCH_CHIP_AXIS_OVERRIDE_RATIO_NUM);
        }
        else if ((chip_dir == MOS_IQS7211A_SLIDE_Y_INCREASE) || (chip_dir == MOS_IQS7211A_SLIDE_Y_DECREASE))
        {
            chip_axis_conflict =
                (abs_x * MOS_TOUCH_CHIP_AXIS_OVERRIDE_RATIO_DEN) >= (abs_y * MOS_TOUCH_CHIP_AXIS_OVERRIDE_RATIO_NUM);
        }

        if (!chip_axis_conflict)
        {
            *out_dir = chip_dir;
            *out_valid = true;
            *out_confidence = 100U;
            return;
        }
    }

    if (max_axis < MOS_TOUCH_RESOLVE_MIN_TRAVEL)
    {
        return;
    }
    if ((abs_x * MOS_TOUCH_RESOLVE_X_DOM_RATIO_DEN) >= (abs_y * MOS_TOUCH_RESOLVE_X_DOM_RATIO_NUM))
    {
        const int32_t score = (100 * (abs_x - abs_y)) / ((abs_x > 0) ? abs_x : 1);
        *out_dir = (stroke_dx >= 0) ? MOS_IQS7211A_SLIDE_X_INCREASE : MOS_IQS7211A_SLIDE_X_DECREASE;
        *out_valid = true;
        *out_confidence = (score < 0) ? 0U : (score > 90 ? 90U : (uint8_t)score);
        return;
    }

    if ((abs_y * MOS_TOUCH_RESOLVE_Y_DOM_RATIO_DEN) >= (abs_x * MOS_TOUCH_RESOLVE_Y_DOM_RATIO_NUM))
    {
        const int32_t score = (100 * (abs_y - abs_x)) / ((abs_y > 0) ? abs_y : 1);
        *out_dir = (stroke_dy >= 0) ? MOS_IQS7211A_SLIDE_Y_INCREASE : MOS_IQS7211A_SLIDE_Y_DECREASE;
        *out_valid = true;
        *out_confidence = (score < 0) ? 0U : (score > 90 ? 90U : (uint8_t)score);
    }
}

static const char *mos_touch_app_dir_str(mos_iqs7211a_slide_direction_t direction)
{
    switch (direction)
    {
        case MOS_IQS7211A_SLIDE_X_INCREASE:
            return "X+";
        case MOS_IQS7211A_SLIDE_X_DECREASE:
            return "X-";
        case MOS_IQS7211A_SLIDE_Y_INCREASE:
            return "Y+";
        case MOS_IQS7211A_SLIDE_Y_DECREASE:
            return "Y-";
        case MOS_IQS7211A_SLIDE_NONE:
        default:
            return "NONE";
    }
}

static const char *mos_touch_app_label_str(mos_iqs7211a_slide_direction_t direction)
{
    switch (direction)
    {
        case MOS_IQS7211A_SLIDE_X_INCREASE:
            return "SWIPE_X_POSITIVE";
        case MOS_IQS7211A_SLIDE_X_DECREASE:
            return "SWIPE_X_NEGATIVE";
        case MOS_IQS7211A_SLIDE_Y_INCREASE:
            return "SWIPE_Y_POSITIVE";
        case MOS_IQS7211A_SLIDE_Y_DECREASE:
            return "SWIPE_Y_NEGATIVE";
        case MOS_IQS7211A_SLIDE_NONE:
        default:
            return "NONE";
    }
}
/**
 * @description: IQS7211A手势事件回调处理函数 / IQS7211A gesture event callback handler
 * @note:
 *   该函数在每次触摸事件发生时被调用，负责解析手势、更新内部状态并输出最终识别结果。
 *   This function is called on every touch event, responsible for gesture parsing, updating internal state, and
 * reporting the final recognized result.
 *
 * @param gestures: 来自硬件的手势位 / Gesture bits from hardware
 * @param info_flags: 来自硬件的附加信息位 / Additional info flags from hardware
 * @param finger1_x: 手指1的当前X坐标，0xFFFF表示无效 / Current X coordinate of finger 1, 0xFFFF means invalid
 * @param finger1_y: 手指1的当前Y坐标，0xFFFF表示无效 / Current Y coordinate of finger 1, 0xFFFF means invalid
 * @param rel_x: 手指1自上次有效位置以来的相对X移动距离（像素）/ Relative X movement since last valid position (pixels)
 * @param rel_y: 手指1自上次有效位置以来的相对Y移动距离（像素）/ Relative Y movement since last valid position (pixels)
 * @param user_data: 注册回调时传入的用户数据指针 / User data pointer passed during callback registration
 * @return 无 / None
 */
static void mos_touch_app_runtime_handler(uint16_t gestures, uint16_t info_flags, uint16_t finger1_x,
                                          uint16_t finger1_y, uint16_t rel_x, uint16_t rel_y, void *user_data)
{
    ARG_UNUSED(rel_x);
    ARG_UNUSED(rel_y);
    ARG_UNUSED(user_data);

    bool should_log = false;
    bool event_valid = false;
    uint8_t event_conf = 0;
    mos_iqs7211a_slide_direction_t event_dir = MOS_IQS7211A_SLIDE_NONE;
    /* Require both coordinate validity and non-zero finger count from INFO[9:8] to avoid window-edge ghost frames. */
    const uint8_t info1 = (uint8_t)((info_flags >> 8) & 0x00FFu);
    const uint8_t num_fingers = (uint8_t)(info1 & 0x03u);
    const bool too_many_fingers = ((info_flags & 0x1000u) != 0u);
    const bool edge_saturated = (finger1_y >= MOS_TOUCH_EDGE_Y_MAX) || (rel_y == MOS_TOUCH_EDGE_REL_Y_GLITCH);
    const bool finger_sample_valid =
        (num_fingers > 0U) && !too_many_fingers && !edge_saturated && (finger1_x != 0xFFFFu) && (finger1_y != 0xFFFFu);
    bool finger_valid = finger_sample_valid;

    {
        k_spinlock_key_t key = k_spin_lock(&s_touch_app_lock);

        if (finger_sample_valid)
        {
            s_touch_invalid_streak = 0;
        }
        else if (s_touch_prev_finger_valid && (s_touch_invalid_streak < MOS_TOUCH_RELEASE_INVALID_FRAMES))
        {
            s_touch_invalid_streak++;
            finger_valid = true;
        }

        if (finger_sample_valid)
        {
            if (!s_touch_prev_finger_valid)
            {
                s_touch_prev_f1x = finger1_x;
                s_touch_prev_f1y = finger1_y;
                s_touch_stroke_dx = 0;
                s_touch_stroke_dy = 0;
                s_touch_has_final = false;
                s_touch_final_best_dir = MOS_IQS7211A_SLIDE_NONE;
                s_touch_final_best_conf = 0;
            }
            else
            {
                int32_t step_dx = (int32_t)finger1_x - (int32_t)s_touch_prev_f1x;
                int32_t step_dy = (int32_t)finger1_y - (int32_t)s_touch_prev_f1y;

                /* Drop abnormal one-frame jumps; they are usually invalid boundary/window samples. */
                if ((mos_touch_app_abs32(step_dx) > MOS_TOUCH_MAX_STEP_DELTA)
                    || (mos_touch_app_abs32(step_dy) > MOS_TOUCH_MAX_STEP_DELTA))
                {
                    s_touch_stroke_dx = 0;
                    s_touch_stroke_dy = 0;
                    s_touch_has_final = false;
                    s_touch_final_best_dir = MOS_IQS7211A_SLIDE_NONE;
                    s_touch_final_best_conf = 0;
                }
                else
                {
                    s_touch_stroke_dx += step_dx;
                    s_touch_stroke_dy += step_dy;
                }
                s_touch_prev_f1x = finger1_x;
                s_touch_prev_f1y = finger1_y;
            }

            mos_touch_app_resolve_from_state(gestures, s_touch_stroke_dx, s_touch_stroke_dy, &s_touch_current_dir,
                                             &s_touch_current_valid, &s_touch_current_conf);

            if (s_touch_current_valid && (!s_touch_has_final || (s_touch_current_conf >= s_touch_final_best_conf)))
            {
                s_touch_has_final = true;
                s_touch_final_best_dir = s_touch_current_dir;
                s_touch_final_best_conf = s_touch_current_conf;
            }
        }
        else if (!finger_valid)
        {
            s_touch_current_dir = MOS_IQS7211A_SLIDE_NONE;
            s_touch_current_valid = false;
            s_touch_current_conf = 0;
        }

        if (s_touch_prev_finger_valid && !finger_valid)
        {
            if (s_touch_has_final)
            {
                event_dir = s_touch_final_best_dir;
                event_valid = true;
                event_conf = s_touch_final_best_conf;
            }

            s_touch_last_event_dir = event_dir;
            s_touch_last_event_valid = event_valid;
            s_touch_last_event_conf = event_conf;
            s_touch_last_event_seq++;
            should_log = true;
        }

        if (!finger_valid)
        {
            s_touch_invalid_streak = 0;
            s_touch_prev_f1x = 0xFFFFu;
            s_touch_prev_f1y = 0xFFFFu;
            s_touch_stroke_dx = 0;
            s_touch_stroke_dy = 0;
            s_touch_has_final = false;
            s_touch_final_best_dir = MOS_IQS7211A_SLIDE_NONE;
            s_touch_final_best_conf = 0;
        }

        s_touch_prev_finger_valid = finger_valid;
        k_spin_unlock(&s_touch_app_lock, key);
    }

    if (!should_log)
    {
        return;
    }

    if (event_valid)
    {
        LOG_INF("[TOUCH] Final gesture: %s (%s, confidence=%u)", mos_touch_app_dir_str(event_dir),
                mos_touch_app_label_str(event_dir), (unsigned int)event_conf);
    }
    else
    {
        LOG_INF("[TOUCH] Final gesture: NONE (insufficient stroke or ambiguous direction)");
    }
}

int mos_touch_app_init(void)
{
    int ret = mos_iqs7211a_init();
    if (ret != 0)
    {
        LOG_ERR("IQS init failed: %d", ret);
        return ret;
    }

    ret = mos_touch_app_apply_balanced_profile();
    if (ret != 0)
    {
        return ret;
    }

    ret = mos_touch_app_finalize_profile_load();
    if (ret != 0)
    {
        return ret;
    }

    ret = mos_iqs7211a_register_runtime_callback(mos_touch_app_runtime_handler, NULL);
    if (ret != 0)
    {
        LOG_ERR("Failed to register touch runtime callback: %d", ret);
        return ret;
    }

    LOG_INF("Touch application ready");
    return 0;
}

int mos_touch_app_get_resolved_gesture(mos_iqs7211a_slide_direction_t *out_dir, bool *out_valid,
                                       uint8_t *out_confidence)
{
    if (!out_dir && !out_valid && !out_confidence)
    {
        return -EINVAL;
    }

    k_spinlock_key_t key = k_spin_lock(&s_touch_app_lock);
    if (out_dir)
    {
        *out_dir = s_touch_current_dir;
    }
    if (out_valid)
    {
        *out_valid = s_touch_current_valid;
    }
    if (out_confidence)
    {
        *out_confidence = s_touch_current_conf;
    }
    k_spin_unlock(&s_touch_app_lock, key);

    return 0;
}

int mos_touch_app_get_last_final_gesture_event(mos_iqs7211a_slide_direction_t *out_dir, bool *out_valid,
                                               uint8_t *out_confidence, uint32_t *out_sequence)
{
    if (!out_dir && !out_valid && !out_confidence && !out_sequence)
    {
        return -EINVAL;
    }

    k_spinlock_key_t key = k_spin_lock(&s_touch_app_lock);
    if (out_dir)
    {
        *out_dir = s_touch_last_event_dir;
    }
    if (out_valid)
    {
        *out_valid = s_touch_last_event_valid;
    }
    if (out_confidence)
    {
        *out_confidence = s_touch_last_event_conf;
    }
    if (out_sequence)
    {
        *out_sequence = s_touch_last_event_seq;
    }
    k_spin_unlock(&s_touch_app_lock, key);

    return 0;
}
