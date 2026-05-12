#include "mos_touch_iqs7211e_profile.h"

#include <zephyr/sys/util.h>


/* 0x1F~0x20: ALP ATI compensation values.
 * 0x1F~0x20：ALP ATI 补偿参数。*/
static const uint8_t s_iqs_profile_alp_comp_0x1f[] = {
    ALP_COMPENSATION_A_0,
    ALP_COMPENSATION_A_1,
    ALP_COMPENSATION_B_0,
    ALP_COMPENSATION_B_1,
};
/* 0x21~0x27: TP/ALP ATI calibration, target and drift tuning.
 * 0x21~0x27：TP/ALP ATI 校准、目标值与漂移参数。*/
static const uint8_t s_iqs_profile_ati_0x21[] = {
    TP_ATI_MULTIPLIERS_DIVIDERS_0,
    TP_ATI_MULTIPLIERS_DIVIDERS_1,
    TP_COMPENSATION_DIV,
    TP_REF_DRIFT_LIMIT,
    TP_ATI_TARGET_0,
    TP_ATI_TARGET_1,
    TP_MIN_COUNT_REATI_0,
    TP_MIN_COUNT_REATI_1,
    ALP_ATI_MULTIPLIERS_DIVIDERS_0,
    ALP_ATI_MULTIPLIERS_DIVIDERS_1,
    ALP_COMPENSATION_DIV,
    ALP_LTA_DRIFT_LIMIT,
    ALP_ATI_TARGET_0,
    ALP_ATI_TARGET_1,
};
/* 0x28~0x32: Report rates and mode timeout behavior.
 * 0x28~0x32：上报速率与各工作模式超时行为。*/
static const uint8_t s_iqs_profile_rates_0x28[] = {
    ACTIVE_MODE_REPORT_RATE_0,
    ACTIVE_MODE_REPORT_RATE_1,
    IDLE_TOUCH_MODE_REPORT_RATE_0,
    IDLE_TOUCH_MODE_REPORT_RATE_1,
    IDLE_MODE_REPORT_RATE_0,
    IDLE_MODE_REPORT_RATE_1,
    LP1_MODE_REPORT_RATE_0,
    LP1_MODE_REPORT_RATE_1,
    LP2_MODE_REPORT_RATE_0,
    LP2_MODE_REPORT_RATE_1,
    ACTIVE_MODE_TIMEOUT_0,
    ACTIVE_MODE_TIMEOUT_1,
    IDLE_TOUCH_MODE_TIMEOUT_0,
    IDLE_TOUCH_MODE_TIMEOUT_1,
    IDLE_MODE_TIMEOUT_0,
    IDLE_MODE_TIMEOUT_1,
    LP1_MODE_TIMEOUT_0,
    LP1_MODE_TIMEOUT_1,
    REATI_RETRY_TIME,
    REF_UPDATE_TIME,
    I2C_TIMEOUT_0,
    I2C_TIMEOUT_1,
};
/* 0x36~0x37: ALP setup and ALP TX channel enable mask.
 * 0x36~0x37：ALP 功能设置与 ALP TX 通道使能掩码。*/
static const uint8_t s_iqs_profile_alp_setup_0x36[] = {
    ALP_SETUP_0,
    ALP_SETUP_1,
    ALP_TX_ENABLE_0,
    ALP_TX_ENABLE_1,
};
/* 0x38~0x3A: Touch/ALP threshold and debounce sensitivity.
 * 0x38~0x3A：触摸/ALP 阈值与去抖灵敏度配置。*/
static const uint8_t s_iqs_profile_threshold_0x38[] = {
    TRACKPAD_TOUCH_SET_THRESHOLD,
    TRACKPAD_TOUCH_CLEAR_THRESHOLD,
    ALP_THRESHOLD_0,
    ALP_THRESHOLD_1,
    ALP_SET_DEBOUNCE,
    ALP_CLEAR_DEBOUNCE,
};
/* 0x3B~0x3C: LP filter beta coefficients for ALP count/LTA.
 * 0x3B~0x3C：低功耗滤波 beta 系数（ALP count/LTA）。*/
static const uint8_t s_iqs_profile_lp_filter_0x3b[] = {
    ALP_COUNT_BETA_LP1,
    ALP_LTA_BETA_LP1,
    ALP_COUNT_BETA_LP2,
    ALP_LTA_BETA_LP2,
};
/* 0x3D~0x40: Conversion frequency and hardware front-end setup.
 * 0x3D~0x40：转换频率与硬件前端参数配置。*/
static const uint8_t s_iqs_profile_hw_0x3d[] = {
    TP_CONVERSION_FREQUENCY_UP_PASS_LENGTH,
    TP_CONVERSION_FREQUENCY_FRACTION_VALUE,
    ALP_CONVERSION_FREQUENCY_UP_PASS_LENGTH,
    ALP_CONVERSION_FREQUENCY_FRACTION_VALUE,
    TRACKPAD_HARDWARE_SETTINGS_0,
    TRACKPAD_HARDWARE_SETTINGS_1,
    ALP_HARDWARE_SETTINGS_0,
    ALP_HARDWARE_SETTINGS_1,
};
/* 0x41~0x49: Trackpad geometry, XY filter and trim settings.
 * 0x41~0x49：触控板几何、XY 滤波与 trim 参数。*/
static const uint8_t s_iqs_profile_trackpad_0x41[] = {
    TRACKPAD_SETTINGS_0_0,
    TRACKPAD_SETTINGS_0_1,
    TRACKPAD_SETTINGS_1_0,
    TRACKPAD_SETTINGS_1_1,
    X_RESOLUTION_0,
    X_RESOLUTION_1,
    Y_RESOLUTION_0,
    Y_RESOLUTION_1,
    XY_DYNAMIC_FILTER_BOTTOM_SPEED_0,
    XY_DYNAMIC_FILTER_BOTTOM_SPEED_1,
    XY_DYNAMIC_FILTER_TOP_SPEED_0,
    XY_DYNAMIC_FILTER_TOP_SPEED_1,
    XY_DYNAMIC_FILTER_BOTTOM_BETA,
    XY_DYNAMIC_FILTER_STATIC_FILTER_BETA,
    STATIONARY_TOUCH_MOV_THRESHOLD,
    FINGER_SPLIT_FACTOR,
    X_TRIM_VALUE,
    Y_TRIM_VALUE,
};
/* 0x4A: Settings version tag used by firmware profile.
 * 0x4A：固件配置版本标记。*/
static const uint8_t s_iqs_profile_settings_ver_0x4a[] = {
    MINOR_VERSION,
    MAJOR_VERSION,
};
/* 0x4B~0x55: Gesture enable and timing/distance thresholds from the Azoteq tool.
 * 0x4B~0x55：上位机导出的手势使能、时间与距离阈值。*/
static const uint8_t s_iqs_profile_gesture_0x4b[] = {
    GESTURE_ENABLE_0,
    GESTURE_ENABLE_1,
    TAP_TOUCH_TIME_0,
    TAP_TOUCH_TIME_1,
    TAP_WAIT_TIME_0,
    TAP_WAIT_TIME_1,
    TAP_DISTANCE_0,
    TAP_DISTANCE_1,
    HOLD_TIME_0,
    HOLD_TIME_1,
    SWIPE_TIME_0,
    SWIPE_TIME_1,
    SWIPE_X_DISTANCE_0,
    SWIPE_X_DISTANCE_1,
    SWIPE_Y_DISTANCE_0,
    SWIPE_Y_DISTANCE_1,
    SWIPE_X_CONS_DIST_0,
    SWIPE_X_CONS_DIST_1,
    SWIPE_Y_CONS_DIST_0,
    SWIPE_Y_CONS_DIST_1,
    SWIPE_ANGLE,
    PALM_THRESHOLD,
};
/* 0x56~0x5C: RX/TX electrode mapping table.
 * 0x56~0x5C：RX/TX 电极映射表。*/
static const uint8_t s_iqs_profile_rxtx_map_0x56[] = {
    RX_TX_MAP_0,
    RX_TX_MAP_1,
    RX_TX_MAP_2,
    RX_TX_MAP_3,
    RX_TX_MAP_4,
    RX_TX_MAP_5,
    RX_TX_MAP_6,
    RX_TX_MAP_7,
    RX_TX_MAP_8,
    RX_TX_MAP_9,
    RX_TX_MAP_10,
    RX_TX_MAP_11,
    RX_TX_MAP_12,
    RX_TX_MAP_FILLER,
};
/* [Module] 0x5D~0x7C: Channel cycle allocation tables */
/* 0x5D~0x6B: Channel allocation for cycles 0~9.
 * 0x5D~0x6B：扫描周期 0~9 的通道分配。*/
static const uint8_t s_iqs_profile_cycle_0_to_9_0x5d[] = {
    PLACEHOLDER_0,
    CH_1_CYCLE_0,
    CH_2_CYCLE_0,
    PLACEHOLDER_1,
    CH_1_CYCLE_1,
    CH_2_CYCLE_1,
    PLACEHOLDER_2,
    CH_1_CYCLE_2,
    CH_2_CYCLE_2,
    PLACEHOLDER_3,
    CH_1_CYCLE_3,
    CH_2_CYCLE_3,
    PLACEHOLDER_4,
    CH_1_CYCLE_4,
    CH_2_CYCLE_4,
    PLACEHOLDER_5,
    CH_1_CYCLE_5,
    CH_2_CYCLE_5,
    PLACEHOLDER_6,
    CH_1_CYCLE_6,
    CH_2_CYCLE_6,
    PLACEHOLDER_7,
    CH_1_CYCLE_7,
    CH_2_CYCLE_7,
    PLACEHOLDER_8,
    CH_1_CYCLE_8,
    CH_2_CYCLE_8,
    PLACEHOLDER_9,
    CH_1_CYCLE_9,
    CH_2_CYCLE_9,
};
/* 0x6C~0x7A: Channel allocation for cycles 10~19.
 * 0x6C~0x7A：扫描周期 10~19 的通道分配。*/
static const uint8_t s_iqs_profile_cycle_10_to_19_0x6c[] = {
    PLACEHOLDER_10,
    CH_1_CYCLE_10,
    CH_2_CYCLE_10,
    PLACEHOLDER_11,
    CH_1_CYCLE_11,
    CH_2_CYCLE_11,
    PLACEHOLDER_12,
    CH_1_CYCLE_12,
    CH_2_CYCLE_12,
    PLACEHOLDER_13,
    CH_1_CYCLE_13,
    CH_2_CYCLE_13,
    PLACEHOLDER_14,
    CH_1_CYCLE_14,
    CH_2_CYCLE_14,
    PLACEHOLDER_15,
    CH_1_CYCLE_15,
    CH_2_CYCLE_15,
    PLACEHOLDER_16,
    CH_1_CYCLE_16,
    CH_2_CYCLE_16,
    PLACEHOLDER_17,
    CH_1_CYCLE_17,
    CH_2_CYCLE_17,
    PLACEHOLDER_18,
    CH_1_CYCLE_18,
    CH_2_CYCLE_18,
    PLACEHOLDER_19,
    CH_1_CYCLE_19,
    CH_2_CYCLE_19,
};
/* 0x7B~0x7C: Channel allocation for cycle 20.
 * 0x7B~0x7C：扫描周期 20 的通道分配。*/
static const uint8_t s_iqs_profile_cycle_20_0x7b[] = {
    PLACEHOLDER_20,
    CH_1_CYCLE_20,
    CH_2_CYCLE_20,
};

/* [Module] Ordered write plan for initialization */
/* Ordered block write sequence during profile load.
 * 配置加载时的分块写入顺序。*/
static const mos_touch_iqs7211e_profile_block_t s_iqs_profile_blocks[] = {
    {.start_reg = 0x1F, .data = s_iqs_profile_alp_comp_0x1f, .len = sizeof(s_iqs_profile_alp_comp_0x1f)},
    {.start_reg = 0x21, .data = s_iqs_profile_ati_0x21, .len = sizeof(s_iqs_profile_ati_0x21)},
    {.start_reg = 0x28, .data = s_iqs_profile_rates_0x28, .len = sizeof(s_iqs_profile_rates_0x28)},
    {.start_reg = 0x36, .data = s_iqs_profile_alp_setup_0x36, .len = sizeof(s_iqs_profile_alp_setup_0x36)},
    {.start_reg = 0x38, .data = s_iqs_profile_threshold_0x38, .len = sizeof(s_iqs_profile_threshold_0x38)},
    {.start_reg = 0x3B, .data = s_iqs_profile_lp_filter_0x3b, .len = sizeof(s_iqs_profile_lp_filter_0x3b)},
    {.start_reg = 0x3D, .data = s_iqs_profile_hw_0x3d, .len = sizeof(s_iqs_profile_hw_0x3d)},
    {.start_reg = 0x41, .data = s_iqs_profile_trackpad_0x41, .len = sizeof(s_iqs_profile_trackpad_0x41)},
    {.start_reg = 0x4A, .data = s_iqs_profile_settings_ver_0x4a, .len = sizeof(s_iqs_profile_settings_ver_0x4a)},
    {.start_reg = 0x4B, .data = s_iqs_profile_gesture_0x4b, .len = sizeof(s_iqs_profile_gesture_0x4b)},
    {.start_reg = 0x56, .data = s_iqs_profile_rxtx_map_0x56, .len = sizeof(s_iqs_profile_rxtx_map_0x56)},
    {.start_reg = 0x5D, .data = s_iqs_profile_cycle_0_to_9_0x5d, .len = sizeof(s_iqs_profile_cycle_0_to_9_0x5d)},
    {.start_reg = 0x6C, .data = s_iqs_profile_cycle_10_to_19_0x6c, .len = sizeof(s_iqs_profile_cycle_10_to_19_0x6c)},
    {.start_reg = 0x7B, .data = s_iqs_profile_cycle_20_0x7b, .len = sizeof(s_iqs_profile_cycle_20_0x7b)},
};

size_t mos_touch_iqs7211e_profile_block_count(void)
{
    return ARRAY_SIZE(s_iqs_profile_blocks);
}

const mos_touch_iqs7211e_profile_block_t *mos_touch_iqs7211e_profile_block_at(size_t index)
{
    if (index >= ARRAY_SIZE(s_iqs_profile_blocks))
    {
        return NULL;
    }

    return &s_iqs_profile_blocks[index];
}
