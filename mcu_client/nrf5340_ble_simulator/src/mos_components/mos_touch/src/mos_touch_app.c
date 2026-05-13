#include "mos_touch_app.h"

#include <display/lcd/a6n.h>
#include <errno.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/spinlock.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/poweroff.h>
#include <zephyr/sys/reboot.h>
#include <zephyr/sys/util.h>

#include "mos_display.h"
#include "mos_gx8002.h"
#include "mos_i2s_slave.h"
#include "mos_imu.h"
#include "mos_npm1300_ldsw.h"
#include "mos_opt3006.h"
#include "mos_touch_iqs7211e_profile.h"
#include "vad_interrupt_handler.h"

LOG_MODULE_REGISTER(mos_touch_app, LOG_LEVEL_INF);

#define MOS_TOUCH_IQS_INFO_ATI_ERROR_BIT        BIT(3)
#define MOS_TOUCH_IQS_INFO_RE_ATI_OCCURRED_BIT  BIT(4)
#define MOS_TOUCH_IQS_INFO_SHOW_RESET_BIT       BIT(7)
#define MOS_TOUCH_IQS_SYSTEM_ACK_RESET_MASK     0x0080u
#define MOS_TOUCH_IQS_SYSTEM_RE_ATI_MASK        0x0020u
#define MOS_TOUCH_ATI_WAIT_POLL_MS              20
#define MOS_TOUCH_ATI_WAIT_TIMEOUT_MS           300
/* Deferred logging can sleep up to CONFIG_LOG_PROCESS_THREAD_SLEEP_MS=1000ms.
 * Keep this delay so the reboot log reaches RTT/UART before sys_reboot();
 * this intentionally makes the observed long-press reboot about 1.2s later than the chip event. */
#define MOS_TOUCH_REBOOT_DELAY_MS               1200
#define MOS_TOUCH_DUPLICATE_GESTURE_SUPPRESS_MS 120 // 设置重复手势抑制时间为120ms，防止连续帧中同一脉冲手势被多次上报；set the duplicate gesture suppression time to 120ms to prevent the same pulse gesture from being reported multiple times in consecutive frames
#define MOS_TOUCH_LATCHED_GESTURE_MASK                                                                           \
    (IQS7211E_GESTURE_PRESS_AND_HOLD | IQS7211E_GESTURE_PALM | IQS7211E_GESTURE_SWIPE_HOLD_X_POSITIVE |          \
     IQS7211E_GESTURE_SWIPE_HOLD_X_NEGATIVE | IQS7211E_GESTURE_SWIPE_HOLD_Y_POSITIVE |                           \
     IQS7211E_GESTURE_SWIPE_HOLD_Y_NEGATIVE)
/* Frame validity guardrails only; gesture recognition comes from the IQS7211E gesture bits.
 * 仅用于帧有效性判断；手势识别只使用 IQS7211E gesture bits。*/
#define MOS_TOUCH_EDGE_Y_MAX                    0x03F0u
#define MOS_TOUCH_EDGE_REL_Y_GLITCH             0x0201u

static uint16_t s_touch_prev_reported_gesture_bits = 0;
/* Short duplicate guard only; identical chip gesture bits must still be allowed as separate later events.
 * 仅短时间抑制重复；相同 chip gesture bits 后续仍应作为独立事件上报。*/
static int64_t s_touch_prev_reported_gesture_ms = 0;
static bool s_touch_debug_frame_logging = false;

static struct k_work s_touch_sleep_work;
static struct k_work_delayable s_touch_reboot_work;
static atomic_t s_touch_sleep_pending = ATOMIC_INIT(0);
static atomic_t s_touch_reboot_pending = ATOMIC_INIT(0);

static void mos_touch_app_reset_runtime_state(void);
static void mos_touch_app_sleep_work_handler(struct k_work *work);
static void mos_touch_app_reboot_work_handler(struct k_work *work);

extern void configure_default_low_pins(void);
extern void mic_power_control(bool enable);

typedef enum
{
    MOS_TOUCH_LOGICAL_NONE = 0,
    MOS_TOUCH_LOGICAL_SINGLE_TAP,
    MOS_TOUCH_LOGICAL_DOUBLE_TAP,
    MOS_TOUCH_LOGICAL_TRIPLE_TAP,
    MOS_TOUCH_LOGICAL_PRESS_AND_HOLD,
} mos_touch_logical_event_t;

static int mos_touch_app_write_profile_blocks(void)
{
    for (size_t i = 0; i < mos_touch_iqs7211e_profile_block_count(); i++)
    {
        const mos_touch_iqs7211e_profile_block_t *block = mos_touch_iqs7211e_profile_block_at(i);
        int ret = mos_iqs7211e_write_block8(block->start_reg, block->data, block->len);
        if (ret != 0)
        {
            LOG_ERR("Touch profile block 0x%02x write failed: %d", block->start_reg, ret);
            return ret;
        }
    }

    LOG_INF("Touch profile applied from IQS7211E_init.h (0x1F~0x7C)");
    return 0;
}

static int mos_touch_app_activate_profile(void)
{
    const uint8_t fae_system_settings[] = {
        SYSTEM_CONTROL_0 | (uint8_t)MOS_TOUCH_IQS_SYSTEM_ACK_RESET_MASK | (uint8_t)MOS_TOUCH_IQS_SYSTEM_RE_ATI_MASK,
        SYSTEM_CONTROL_1,
        /* Keep host-controlled active mode so the first tap after idle is not consumed as a wake-up touch.
         保持主机控制的活跃模式，以便空闲后第一次点击不会被用作唤醒触摸。*/
        CONFIG_SETTINGS0 | (uint8_t)(IQS7211E_CONFIG_COMMS_END_CMD | IQS7211E_CONFIG_MANUAL_CONTROL),
        CONFIG_SETTINGS1 | (uint8_t)(IQS7211E_CONFIG_EVENT_MODE >> 8),
        OTHER_SETTINGS_0,
        OTHER_SETTINGS_1,
    };

    int ret = mos_iqs7211e_write_block8(IQS7211E_REG_SYSTEM_CONTROL, fae_system_settings, sizeof(fae_system_settings));
    if (ret != 0)
    {
        LOG_ERR("IQS FAE final system settings failed: %d", ret);
        return ret;
    }

    bool reati_seen = false;
    uint16_t last_info_flags = 0;
    k_sleep(K_MSEC(80));

    const int64_t reati_wait_deadline = k_uptime_get() + MOS_TOUCH_ATI_WAIT_TIMEOUT_MS;
    while (k_uptime_get() < reati_wait_deadline)
    {
        uint16_t info_flags = 0;

        ret = mos_iqs7211e_read_event_states(&info_flags, NULL);
        if (ret == 0)
        {
            last_info_flags = info_flags;
            if ((info_flags & MOS_TOUCH_IQS_INFO_RE_ATI_OCCURRED_BIT) != 0U)
            {
                reati_seen = true;
            }

            if (reati_seen)
            {
                if ((info_flags & MOS_TOUCH_IQS_INFO_ATI_ERROR_BIT) != 0U)
                {
                    LOG_WRN("IQS ATI completed with ATI_ERROR still set (INFO=0x%04x)", info_flags);
                }
                break;
            }
        }

        const int64_t remaining_ms = reati_wait_deadline - k_uptime_get();
        if (remaining_ms > 0)
        {
            k_sleep(K_MSEC(MIN((int64_t)MOS_TOUCH_ATI_WAIT_POLL_MS, remaining_ms)));
        }
    }

    if (!reati_seen)
    {
        LOG_WRN("IQS ReATI completion flag not observed before timeout (last INFO=0x%04x)", last_info_flags);
    }

    /* Force one runtime read after profile activation so the first user touch is not used as the sync frame.
        首次运行时读取，以确保第一次用户触摸不会被用作同步帧。*/
    ret = mos_iqs7211e_refresh_runtime_cache();
    if (ret != 0)
    {
        LOG_ERR("IQS runtime cache sync after profile activation failed: %d", ret);
        return ret;
    }

    LOG_INF("IQS runtime cache synchronized after profile activation");
    return 0;
}

static const char *mos_touch_app_logical_event_str(mos_touch_logical_event_t event)
{
    switch (event)
    {
        case MOS_TOUCH_LOGICAL_SINGLE_TAP:
            return "SINGLE_TAP";
        case MOS_TOUCH_LOGICAL_DOUBLE_TAP:
            return "DOUBLE_TAP";
        case MOS_TOUCH_LOGICAL_TRIPLE_TAP:
            return "TRIPLE_TAP";
        case MOS_TOUCH_LOGICAL_PRESS_AND_HOLD:
            return "PRESS_AND_HOLD";
        case MOS_TOUCH_LOGICAL_NONE:
        default:
            return "NONE";
    }
}

static mos_touch_logical_event_t mos_touch_app_chip_discrete_event(uint16_t gestures)
{
    if ((gestures & IQS7211E_GESTURE_TRIPLE_TAP) != 0U)
    {
        return MOS_TOUCH_LOGICAL_TRIPLE_TAP;
    }
    if ((gestures & IQS7211E_GESTURE_DOUBLE_TAP) != 0U)
    {
        return MOS_TOUCH_LOGICAL_DOUBLE_TAP;
    }
    if ((gestures & IQS7211E_GESTURE_SINGLE_TAP) != 0U)
    {
        return MOS_TOUCH_LOGICAL_SINGLE_TAP;
    }
    if ((gestures & IQS7211E_GESTURE_PRESS_AND_HOLD) != 0U)
    {
        return MOS_TOUCH_LOGICAL_PRESS_AND_HOLD;
    }
    return MOS_TOUCH_LOGICAL_NONE;
}

static void mos_touch_app_emit_logical_event(mos_touch_logical_event_t event, const char *source)
{
    if (event == MOS_TOUCH_LOGICAL_NONE)
    {
        return;
    }

    LOG_INF("[TOUCH] Logical event: %s (%s)", mos_touch_app_logical_event_str(event), source);
}

static void mos_touch_app_request_sleep(void)
{
    if (!atomic_cas(&s_touch_sleep_pending, 0, 1))
    {
        return;
    }

    int ret = k_work_submit(&s_touch_sleep_work);
    if (ret < 0)
    {
        atomic_set(&s_touch_sleep_pending, 0);
        LOG_ERR("Failed to schedule touch sleep work: %d", ret);
    }
}

static void mos_touch_app_request_reboot(void)
{
    if (!atomic_cas(&s_touch_reboot_pending, 0, 1))
    {
        return;
    }

    LOG_INF("PRESS_AND_HOLD detected - rebooting device");

    /* The delay is for log flush visibility only; sys_reboot() itself runs in the delayed work handler. */
    int ret = k_work_schedule(&s_touch_reboot_work, K_MSEC(MOS_TOUCH_REBOOT_DELAY_MS));
    if (ret < 0)
    {
        atomic_set(&s_touch_reboot_pending, 0);
        LOG_ERR("Failed to schedule touch reboot work: %d", ret);
    }
}

static uint16_t mos_touch_app_chip_gesture_mask(void)
{
    return IQS7211E_GESTURE_SINGLE_TAP | IQS7211E_GESTURE_DOUBLE_TAP | IQS7211E_GESTURE_TRIPLE_TAP |
           IQS7211E_GESTURE_PRESS_AND_HOLD | IQS7211E_GESTURE_PALM | IQS7211E_GESTURE_SWIPE_X_POSITIVE |
           IQS7211E_GESTURE_SWIPE_X_NEGATIVE | IQS7211E_GESTURE_SWIPE_Y_POSITIVE | IQS7211E_GESTURE_SWIPE_Y_NEGATIVE |
           IQS7211E_GESTURE_SWIPE_HOLD_X_POSITIVE | IQS7211E_GESTURE_SWIPE_HOLD_X_NEGATIVE |
           IQS7211E_GESTURE_SWIPE_HOLD_Y_POSITIVE | IQS7211E_GESTURE_SWIPE_HOLD_Y_NEGATIVE;
}

static const char *mos_touch_app_raw_gesture_str(uint16_t gestures)
{
    if (gestures == IQS7211E_GESTURE_SINGLE_TAP)
    {
        return "SINGLE_TAP";
    }
    if (gestures == IQS7211E_GESTURE_DOUBLE_TAP)
    {
        return "DOUBLE_TAP";
    }
    if (gestures == IQS7211E_GESTURE_TRIPLE_TAP)
    {
        return "TRIPLE_TAP";
    }
    if (gestures == IQS7211E_GESTURE_PRESS_AND_HOLD)
    {
        return "PRESS_AND_HOLD";
    }
    if (gestures == IQS7211E_GESTURE_PALM)
    {
        return "PALM";
    }
    if (gestures == IQS7211E_GESTURE_SWIPE_X_POSITIVE)
    {
        return "SWIPE_X_POSITIVE";
    }
    if (gestures == IQS7211E_GESTURE_SWIPE_X_NEGATIVE)
    {
        return "SWIPE_X_NEGATIVE";
    }
    if (gestures == IQS7211E_GESTURE_SWIPE_Y_POSITIVE)
    {
        return "SWIPE_Y_POSITIVE";
    }
    if (gestures == IQS7211E_GESTURE_SWIPE_Y_NEGATIVE)
    {
        return "SWIPE_Y_NEGATIVE";
    }
    if (gestures == IQS7211E_GESTURE_SWIPE_HOLD_X_POSITIVE)
    {
        return "SWIPE_HOLD_X_POSITIVE";
    }
    if (gestures == IQS7211E_GESTURE_SWIPE_HOLD_X_NEGATIVE)
    {
        return "SWIPE_HOLD_X_NEGATIVE";
    }
    if (gestures == IQS7211E_GESTURE_SWIPE_HOLD_Y_POSITIVE)
    {
        return "SWIPE_HOLD_Y_POSITIVE";
    }
    if (gestures == IQS7211E_GESTURE_SWIPE_HOLD_Y_NEGATIVE)
    {
        return "SWIPE_HOLD_Y_NEGATIVE";
    }

    return "MULTI_OR_UNKNOWN";
}
/**
 * @description: 解析滑动方向
 * @note:
 *   - 只接受 IQS7211E 手势寄存器中的单一明确滑动事件；
 *   - 不再根据轨迹距离做软件方向推断。
 *
 *   Resolve slide direction from state:
 *   - Use only a single clear swipe bit from the IQS7211E gesture register.
 *   - Do not infer direction from software trajectory.
 *
 * @param gestures: 来自硬件的手势位 / Gesture bits from hardware
 * @param out_dir: 输出解析得到的滑动方向 / Output resolved direction
 * @return 无 / None
 */
static bool mos_touch_app_decode_single_swipe_gesture(uint16_t gestures, mos_iqs7211e_slide_direction_t *out_dir)
{
    uint8_t count = 0;
    mos_iqs7211e_slide_direction_t direction = MOS_IQS7211E_SLIDE_NONE;

    if ((gestures & IQS7211E_GESTURE_SWIPE_X_NEGATIVE) != 0U)
    {
        count++;
        direction = MOS_IQS7211E_SLIDE_X_DECREASE;
    }
    if ((gestures & IQS7211E_GESTURE_SWIPE_X_POSITIVE) != 0U)
    {
        count++;
        direction = MOS_IQS7211E_SLIDE_X_INCREASE;
    }
    if ((gestures & IQS7211E_GESTURE_SWIPE_Y_POSITIVE) != 0U)
    {
        count++;
        direction = MOS_IQS7211E_SLIDE_Y_INCREASE;
    }
    if ((gestures & IQS7211E_GESTURE_SWIPE_Y_NEGATIVE) != 0U)
    {
        count++;
        direction = MOS_IQS7211E_SLIDE_Y_DECREASE;
    }

    if (count == 1U)
    {
        *out_dir = direction;
        return true;
    }

    return false;
}
static const char *mos_touch_app_dir_str(mos_iqs7211e_slide_direction_t direction)
{
    switch (direction)
    {
        case MOS_IQS7211E_SLIDE_X_INCREASE:
            return "X+";
        case MOS_IQS7211E_SLIDE_X_DECREASE:
            return "X-";
        case MOS_IQS7211E_SLIDE_Y_INCREASE:
            return "Y+";
        case MOS_IQS7211E_SLIDE_Y_DECREASE:
            return "Y-";
        case MOS_IQS7211E_SLIDE_NONE:
        default:
            return "NONE";
    }
}
static const char *mos_touch_app_label_str(mos_iqs7211e_slide_direction_t direction)
{
    switch (direction)
    {
        case MOS_IQS7211E_SLIDE_X_INCREASE:
            return "SWIPE_X_POSITIVE";
        case MOS_IQS7211E_SLIDE_X_DECREASE:
            return "SWIPE_X_NEGATIVE";
        case MOS_IQS7211E_SLIDE_Y_INCREASE:
            return "SWIPE_Y_POSITIVE";
        case MOS_IQS7211E_SLIDE_Y_DECREASE:
            return "SWIPE_Y_NEGATIVE";
        case MOS_IQS7211E_SLIDE_NONE:
        default:
            return "NONE";
    }
}
/**
 * @description: IQS7211E手势事件回调处理函数 / IQS7211E gesture event callback handler
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
    ARG_UNUSED(user_data);

    const uint8_t info1 = (uint8_t)((info_flags >> 8) & 0x00FFu);
    const uint8_t num_fingers = (uint8_t)(info1 & 0x03u);
    const bool too_many_fingers = ((info_flags & 0x1000u) != 0u);
    const bool reati_frame = ((info_flags & MOS_TOUCH_IQS_INFO_RE_ATI_OCCURRED_BIT) != 0u);
    const bool ati_error_frame = ((info_flags & MOS_TOUCH_IQS_INFO_ATI_ERROR_BIT) != 0u);
    const bool reset_frame = ((info_flags & MOS_TOUCH_IQS_INFO_SHOW_RESET_BIT) != 0u);
    const bool edge_saturated = (finger1_y >= MOS_TOUCH_EDGE_Y_MAX) || (rel_y == MOS_TOUCH_EDGE_REL_Y_GLITCH);  // 检查Y轴边缘饱和 / Check for Y edge saturation
    const uint16_t chip_gesture_bits = gestures & mos_touch_app_chip_gesture_mask();
    const bool finger_sample_valid = (num_fingers > 0U) && !too_many_fingers && !edge_saturated && (finger1_x != 0xFFFFu) && (finger1_y != 0xFFFFu);

    if (reset_frame)
    {
        LOG_WRN("IQS7211E reset occurred (INFO=0x%04x), re-applying FAE touch profile", info_flags);
        mos_touch_app_reset_runtime_state();
        mos_iqs7211e_clear_runtime_cache();

        int ret = mos_touch_app_apply_profile();
        if (ret != 0)
        {
            LOG_ERR("IQS7211E profile reload after reset failed: %d", ret);
        }
        else
        {
            mos_touch_app_reset_runtime_state();
            LOG_INF("IQS7211E profile reloaded and runtime state synchronized after reset");
        }
        return;
    }

    if (s_touch_debug_frame_logging)
    {
        LOG_INF("[TOUCH][FRAME] g=0x%04x info=0x%04x nf=%u tmf=%u reati=%u f1=(0x%04x,0x%04x) rel=(%d,%d) edge=%u " "sample_ok=%u",
            gestures, info_flags, (unsigned int)num_fingers, (unsigned int)too_many_fingers, (unsigned int)reati_frame,
            finger1_x, finger1_y, (int16_t)rel_x, (int16_t)rel_y, (unsigned int)edge_saturated,
            (unsigned int)finger_sample_valid);
    }

    if (ati_error_frame)
    {
        mos_touch_app_reset_runtime_state();
        LOG_WRN("IQS ATI_ERROR frame suppressed (INFO=0x%04x, gestures=0x%04x)", info_flags, gestures);
        return;
    }

    if (reati_frame)
    {
        mos_touch_app_reset_runtime_state();
        LOG_DBG("IQS ATI/ReATI status frame suppressed (INFO=0x%04x, gestures=0x%04x)", info_flags, gestures);
        return;
    }

    uint16_t new_gesture_bits = 0;
    {
        const int64_t now_ms = k_uptime_get();
        const uint16_t latched_bits = chip_gesture_bits & MOS_TOUCH_LATCHED_GESTURE_MASK;
        const uint16_t pulse_bits = chip_gesture_bits & (uint16_t)(~MOS_TOUCH_LATCHED_GESTURE_MASK);

        const uint16_t new_latched_bits = latched_bits & (uint16_t)(~s_touch_prev_reported_gesture_bits);
        uint16_t new_pulse_bits = pulse_bits;
        /* Pulse gestures may repeat later, but adjacent duplicate frames are suppressed briefly.
        脉冲手势可能会在稍后重复，但相邻的重复帧会被短暂抑制*/
        if ((pulse_bits != 0U)
            && (pulse_bits == (s_touch_prev_reported_gesture_bits & (uint16_t)(~MOS_TOUCH_LATCHED_GESTURE_MASK)))
            && ((now_ms - s_touch_prev_reported_gesture_ms) < MOS_TOUCH_DUPLICATE_GESTURE_SUPPRESS_MS))
        {
            new_pulse_bits = 0;
        }

        new_gesture_bits = new_latched_bits | new_pulse_bits;
        s_touch_prev_reported_gesture_bits = chip_gesture_bits;
        if (new_gesture_bits != 0U)
        {
            s_touch_prev_reported_gesture_ms = now_ms;
        }
    }

    if (new_gesture_bits == 0U)
    {
        return;
    }
    const uint16_t new_discrete_bits = new_gesture_bits & (IQS7211E_GESTURE_SINGLE_TAP | IQS7211E_GESTURE_DOUBLE_TAP
                                                           | IQS7211E_GESTURE_TRIPLE_TAP | IQS7211E_GESTURE_PRESS_AND_HOLD);

    const uint16_t new_swipe_bits = new_gesture_bits & (IQS7211E_GESTURE_SWIPE_X_POSITIVE | IQS7211E_GESTURE_SWIPE_X_NEGATIVE |
                                                        IQS7211E_GESTURE_SWIPE_Y_POSITIVE | IQS7211E_GESTURE_SWIPE_Y_NEGATIVE);

    const uint16_t raw_remaining_bits = new_gesture_bits & (uint16_t)(~(new_discrete_bits | new_swipe_bits));
    const mos_touch_logical_event_t chip_discrete_event = mos_touch_app_chip_discrete_event(new_discrete_bits);
    mos_iqs7211e_slide_direction_t chip_swipe_dir = MOS_IQS7211E_SLIDE_NONE;
    const bool chip_swipe_valid = mos_touch_app_decode_single_swipe_gesture(new_swipe_bits, &chip_swipe_dir);

    bool emitted = false;

    if (chip_discrete_event != MOS_TOUCH_LOGICAL_NONE)
    {
        mos_touch_app_emit_logical_event(chip_discrete_event, "chip");
        if (chip_discrete_event == MOS_TOUCH_LOGICAL_TRIPLE_TAP)
        {
            mos_touch_app_request_sleep();
        }
        else if (chip_discrete_event == MOS_TOUCH_LOGICAL_PRESS_AND_HOLD)
        {
            mos_touch_app_request_reboot();
        }
        emitted = true;
    }

    if (chip_swipe_valid)
    {
        LOG_INF("[TOUCH] Gesture: %s (%s, source=chip)", mos_touch_app_dir_str(chip_swipe_dir),
                mos_touch_app_label_str(chip_swipe_dir));
        emitted = true;
    }
    /* 显示原始手势，未处理的手势位也会显示；
    show raw gesture if no recognized discrete/swipe event, or if unprocessed bits remain*/
    if (!emitted || (raw_remaining_bits != 0U))
    {
        const uint16_t raw_bits = emitted ? raw_remaining_bits : new_gesture_bits;
        if (raw_bits != 0U)
        {
            LOG_INF("[TOUCH] Raw chip gesture: %s (0x%04x)", mos_touch_app_raw_gesture_str(raw_bits), raw_bits);
        }
    }
}

static void mos_touch_app_emit_cached_startup_gesture(void)
{
    uint16_t gestures = 0;
    uint16_t info_flags = 0;
    uint16_t finger1_x = 0;
    uint16_t finger1_y = 0;
    uint16_t rel_x = 0;
    uint16_t rel_y = 0;

    int ret = mos_iqs7211e_get_last_runtime_data(&gestures, &info_flags, &finger1_x, &finger1_y, &rel_x, &rel_y);
    if (ret != 0)
    {
        return;
    }

    if ((info_flags & MOS_TOUCH_IQS_INFO_SHOW_RESET_BIT) != 0U)
    {
        return;
    }

    if ((gestures & mos_touch_app_chip_gesture_mask()) == 0U)
    {
        return;
    }

    /* The profile activation cache sync can catch the user's first touch before RDY is armed.
     * Emit that cached chip gesture instead of silently consuming it as a startup sync frame.
     * 配置文件激活缓存同步可以在 RDY 启动之前捕获用户的第一次触摸。发出缓存的芯片手势，而不是默默地将其用作启动同步帧 */
    LOG_INF("IQS startup cache contains chip gesture bits; emitting cached first touch");
    mos_touch_app_runtime_handler(gestures, info_flags, finger1_x, finger1_y, rel_x, rel_y, NULL);
}

int mos_touch_app_apply_profile(void)
{
    int ret = mos_touch_app_write_profile_blocks();
    if (ret != 0)
    {
        return ret;
    }

    return mos_touch_app_activate_profile();
}

static void mos_touch_app_reset_runtime_state(void)
{
    s_touch_prev_reported_gesture_bits = 0;
    s_touch_prev_reported_gesture_ms = 0;
}

static void mos_touch_app_abort_sleep_prepare(const char *step, int err)
{
    atomic_set(&s_touch_sleep_pending, 0);
    LOG_ERR("%s failed: %d; aborting System OFF sleep and keeping device awake", step, err);

    int ret = mos_touch_app_apply_profile();
    if (ret != 0)
    {
        LOG_ERR("Failed to restore IQS7211E runtime profile after sleep abort: %d", ret);
    }

    ret = mos_iqs7211e_enable_rdy_interrupt();
    if (ret != 0)
    {
        LOG_ERR("Failed to re-arm IQS7211E RDY interrupt after sleep abort: %d", ret);
    }
}

static void mos_touch_app_sleep_work_handler(struct k_work *work)
{
    ARG_UNUSED(work);

    LOG_INF("Triple tap detected - preparing System OFF sleep with touch wakeup");

    /* Let the current IQS RDY frame finish and return RDY to idle before configuring wake sense. */
    k_sleep(K_MSEC(200));

    int ret = mos_npm1300_ldsw1_enable();
    if (ret != 0)
    {
        LOG_WRN("Failed to keep LDSW1 enabled for touch wakeup: %d", ret);
    }

    ret = mos_iqs7211e_prepare_sleep_wakeup_mode();
    if (ret != 0)
    {
        mos_touch_app_abort_sleep_prepare("IQS7211E sleep wakeup prepare", ret);
        return;
    }

    ret = mos_iqs7211e_configure_wakeup();
    if (ret != 0)
    {
        mos_touch_app_abort_sleep_prepare("IQS7211E touch wakeup configure", ret);
        return;
    }

    /* i2c3 is shared by IQS7211E and OPT3006: only after all touch I2C above may we use/shutdown the bus and suspend TWIM. */
    ret = opt3006_set_mode(OPT3006_MODE_SHUTDOWN);
    if (ret != 0)
    {
        LOG_WRN("OPT3006 shutdown before i2c3 suspend failed: %d", ret);
    }
    else
    {
        LOG_INF("OPT3006 shutdown OK");
    }

    opt3006_prepare_for_sleep();
    LOG_INF("i2c3 suspended after IQS sleep/wake config and OPT3006 shutdown");

    LOG_INF("Powering down remaining peripherals before System OFF");

    /* Reuse the shared MicState OFF local shutdown path, then cut VAD power for System OFF. */
    (void)vad_interrupt_handler_apply_mic_off();
    (void)mos_gx8002_power_control(false);

    mic_power_control(false);
    (void)mos_imu_sleep();

    set_display_onoff(false);
    a6n_power_off();
    a6n_io_off();

    configure_default_low_pins();

    LOG_INF("Entering System OFF sleep mode; touch RDY will wake the device");
    k_sleep(K_MSEC(50));
    sys_poweroff();

    atomic_set(&s_touch_sleep_pending, 0);
    LOG_ERR("sys_poweroff returned unexpectedly");
}

static void mos_touch_app_reboot_work_handler(struct k_work *work)
{
    ARG_UNUSED(work);

    sys_reboot(SYS_REBOOT_COLD);
}

int mos_touch_app_init(void)
{
    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        LOG_ERR("IQS init failed: %d", ret);
        return ret;
    }

    k_work_init(&s_touch_sleep_work, mos_touch_app_sleep_work_handler);
    k_work_init_delayable(&s_touch_reboot_work, mos_touch_app_reboot_work_handler);

    ret = mos_iqs7211e_register_runtime_callback(mos_touch_app_runtime_handler, NULL);
    if (ret != 0)
    {
        LOG_ERR("Failed to register touch runtime callback: %d", ret);
        return ret;
    }

    ret = mos_touch_app_apply_profile();
    if (ret != 0)
    {
        return ret;
    }

    LOG_WRN("IQS7211E profile register values are currently a migration baseline; verify against IQS7211E datasheet");

    mos_touch_app_emit_cached_startup_gesture();

    ret = mos_iqs7211e_enable_rdy_interrupt();
    if (ret != 0)
    {
        LOG_ERR("Failed to enable IQS RDY interrupt: %d", ret);
        return ret;
    }

    LOG_INF("Touch application ready");
    return 0;
}

void mos_touch_app_set_debug_frame_logging(bool enabled)
{
    s_touch_debug_frame_logging = enabled;
    LOG_INF("Touch frame debug logging %s", enabled ? "enabled" : "disabled");
}
