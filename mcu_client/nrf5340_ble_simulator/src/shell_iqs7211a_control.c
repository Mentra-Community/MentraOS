#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>

#include "mos_driver/include/mos_iqs7211a.h"
#include "mos_touch_app.h"

/* |dX| or |dY| below this (after subtracting consecutive finger samples) is treated as noise. */
#define IQS_WATCH_MOVE_THRESH 2
/* Print finger-delta movement summary only when accumulated motion reaches this threshold. */
#define IQS_WATCH_CUM_MOVE_LOG_THRESH 48
/* Lock inferred swipe axis (X or Y) once cumulative movement exceeds this threshold for current touch. */
#define IQS_WATCH_AXIS_LOCK_THRESH 64
/* Require clear dominance when locking axis: major/minor >= 1.5 (3/2). */
#define IQS_WATCH_AXIS_LOCK_RATIO_NUM 3
#define IQS_WATCH_AXIS_LOCK_RATIO_DEN 2
/* Only emit inferred swipe after enough cumulative travel on locked axis. */
#define IQS_WATCH_INFER_EMIT_THRESH 96
/* Emit inferred swipe only when locked axis is strongly dominant: major/minor >= 2.0. */
#define IQS_WATCH_INFER_DOM_RATIO_NUM 2
#define IQS_WATCH_INFER_DOM_RATIO_DEN 1
/* Allow inferred direction reversal only after strong opposite cumulative travel. */
#define IQS_WATCH_AXIS_REVERSE_THRESH 120

#define IQS_TERM_COLOR_RESET "\x1b[0m"
#define IQS_TERM_COLOR_GREEN "\x1b[1;32m"
#define IQS_TERM_COLOR_CYAN "\x1b[1;36m"
#define IQS_TERM_COLOR_YELLOW "\x1b[1;33m"
#define IQS_TERM_COLOR_MAGENTA "\x1b[1;35m"
#define IQS_TERM_COLOR_RED "\x1b[1;31m"

LOG_MODULE_REGISTER(shell_iqs7211a, LOG_LEVEL_INF);

static int cmd_iqs7211a_help(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    shell_print(shell, "");
    shell_print(shell, "IQS7211A — shell reads (RDY from main after OPT3006; same I2C bus)");
    shell_print(shell, "");
    shell_print(shell, "  iqs7211a help        - This menu");
    shell_print(shell, "  iqs7211a last        - Cached runtime (INFO/GESTURES/FINGER1 from RDY)");
    shell_print(shell, "  iqs7211a touch       - Same cache as last");
    shell_print(shell, "  iqs7211a stats       - RDY ISR/work/read counters");
    shell_print(shell, "  iqs7211a id / ver    - Product/version words 0x00..0x09 (via RDY window cache)");
    shell_print(shell, "  iqs7211a watch [s]   - Print cache changes for N seconds (RDY armed in main)");
    shell_print(shell, "  iqs7211a slide       - Last slide dir from FINGER1 deltas (driver, same as watch SlideDir)");
    shell_print(shell, "  iqs7211a rdy_on      - Re-arm RDY GPIO if disabled");
    shell_print(shell, "");
    return 0;
}

static int iq_get_version_words(uint16_t *words, size_t words_count)
{
    int ret = mos_iqs7211a_init();
    if (ret != 0)
    {
        return ret;
    }
    return mos_iqs7211a_read_version_details(words, words_count);
}

static int cmd_iqs7211a_id(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    uint16_t words[10] = {0};
    int ret = iq_get_version_words(words, 10U);
    if (ret != 0)
    {
        shell_error(shell, "iqs7211a id failed: %d", ret);
        return ret;
    }

    shell_print(shell, "IQS7211A I2C addr (7-bit): 0x%02x", IQS7211A_I2C_ADDR);
    shell_print(shell, "Version word[0] @ reg 0x00: 0x%04x", words[0]);
    return 0;
}

static int cmd_iqs7211a_ver(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    uint16_t words[10] = {0};
    int ret = iq_get_version_words(words, 10U);
    if (ret != 0)
    {
        shell_error(shell, "iqs7211a ver failed: %d", ret);
        return ret;
    }

    shell_print(shell, "IQS7211A I2C addr (7-bit): 0x%02x", IQS7211A_I2C_ADDR);
    for (size_t i = 0U; i < 10U; i++)
    {
        shell_print(shell, "  reg 0x%02x: 0x%04x", (unsigned)(0x00U + i), words[i]);
    }
    return 0;
}

static int cmd_iqs7211a_touch(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    int ret = mos_iqs7211a_init();
    if (ret != 0)
    {
        shell_error(shell, "iqs7211a init failed: %d", ret);
        return ret;
    }

    uint16_t gestures = 0;
    uint16_t info = 0;
    uint16_t f1x = 0;
    uint16_t f1y = 0;
    ret = mos_iqs7211a_get_last_runtime_data(&gestures, &info, &f1x, &f1y, NULL, NULL);
    if (ret != 0)
    {
        shell_error(shell, "iqs7211a get_last_runtime_data failed: %d", ret);
        if (ret == -EAGAIN)
        {
            shell_print(shell, "Tip: no RDY cache yet — interact with pad once, or check RDY GPIO wiring.");
        }
        return ret;
    }

    shell_print(shell, "IQS7211A I2C addr (7-bit): 0x%02x", IQS7211A_I2C_ADDR);
    shell_print(shell, "GESTURES (0x0E):   0x%04x", gestures);
    shell_print(shell, "INFO_FLAGS (0x0F): 0x%04x", info);
    shell_print(shell, "FINGER1_X (0x10):  0x%04x", f1x);
    shell_print(shell, "FINGER1_Y (0x11):  0x%04x", f1y);
    return 0;
}

static int cmd_iqs7211a_rdy_on(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    int ret = mos_iqs7211a_enable_rdy_interrupt();
    if (ret != 0)
    {
        shell_error(shell, "iqs7211a rdy_on failed: %d", ret);
        shell_print(shell, "Tip: iqs7211a_rdy-gpios GPIO_ACTIVE_LOW + falling edge (see datasheet)");
        return ret;
    }

    shell_print(shell, "IQS7211A RDY GPIO re-armed (falling edge, active-low).");
    return 0;
}

static int cmd_iqs7211a_last(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    uint16_t gestures = 0;
    uint16_t info = 0;
    uint16_t f1x = 0;
    uint16_t f1y = 0;
    int ret = mos_iqs7211a_get_last_runtime_data(&gestures, &info, &f1x, &f1y, NULL, NULL);
    if (ret != 0)
    {
        shell_error(shell, "iqs7211a last failed: %d", ret);
        if (ret == -EAGAIN)
        {
            shell_print(shell, "Tip: interact with pad once to get first RDY update.");
        }
        return ret;
    }

    shell_print(shell, "Cached (from RDY):");
    shell_print(shell, "  INFO_FLAGS (0x10): 0x%04x", info);
    shell_print(shell, "  GESTURES   (0x11): 0x%04x", gestures);
    shell_print(shell, "  FINGER1_X  (0x14): 0x%04x", f1x);
    shell_print(shell, "  FINGER1_Y  (0x15): 0x%04x", f1y);
    return 0;
}

static int cmd_iqs7211a_stats(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    uint32_t isr = 0, work = 0, ok = 0, fail = 0, filt = 0;
    int ret = mos_iqs7211a_get_debug_counters(&isr, &work, &ok, &fail, &filt);
    if (ret != 0)
    {
        shell_error(shell, "iqs7211a stats failed: %d", ret);
        return ret;
    }

    shell_print(shell, "IQS7211A RDY stats:");
    shell_print(shell, "  isr_count       : %u", isr);
    shell_print(shell, "  work_count      : %u", work);
    shell_print(shell, "  read_ok_count   : %u", ok);
    shell_print(shell, "  read_fail_count : %u", fail);
    shell_print(shell, "  filtered_count  : %u", filt);
    return 0;
}

static const char *iqs_slide_dir_str(mos_iqs7211a_slide_direction_t d)
{
    switch (d)
    {
        case MOS_IQS7211A_SLIDE_NONE:
            return "NONE";
        case MOS_IQS7211A_SLIDE_X_INCREASE:
            return "X+";
        case MOS_IQS7211A_SLIDE_X_DECREASE:
            return "X-";
        case MOS_IQS7211A_SLIDE_Y_INCREASE:
            return "Y+";
        case MOS_IQS7211A_SLIDE_Y_DECREASE:
            return "Y-";
        default:
            return "?";
    }
}

static const char *iqs_final_gesture_icon(mos_iqs7211a_slide_direction_t d, bool valid)
{
    if (!valid)
    {
        return "[----]";
    }

    switch (d)
    {
        case MOS_IQS7211A_SLIDE_X_INCREASE:
            return "[>>>>]";
        case MOS_IQS7211A_SLIDE_X_DECREASE:
            return "[<<<<]";
        case MOS_IQS7211A_SLIDE_Y_INCREASE:
            return "[VVVV]";
        case MOS_IQS7211A_SLIDE_Y_DECREASE:
            return "[^^^^]";
        case MOS_IQS7211A_SLIDE_NONE:
        default:
            return "[----]";
    }
}

static const char *iqs_final_gesture_label(mos_iqs7211a_slide_direction_t d, bool valid)
{
    if (!valid)
    {
        return "NONE";
    }

    switch (d)
    {
        case MOS_IQS7211A_SLIDE_X_INCREASE:
            return "RIGHT";
        case MOS_IQS7211A_SLIDE_X_DECREASE:
            return "LEFT";
        case MOS_IQS7211A_SLIDE_Y_INCREASE:
            return "DOWN";
        case MOS_IQS7211A_SLIDE_Y_DECREASE:
            return "UP";
        case MOS_IQS7211A_SLIDE_NONE:
        default:
            return "NONE";
    }
}

static const char *iqs_final_gesture_color(mos_iqs7211a_slide_direction_t d, bool valid)
{
    if (!valid)
    {
        return IQS_TERM_COLOR_RED;
    }

    switch (d)
    {
        case MOS_IQS7211A_SLIDE_X_INCREASE:
            return IQS_TERM_COLOR_GREEN;
        case MOS_IQS7211A_SLIDE_X_DECREASE:
            return IQS_TERM_COLOR_CYAN;
        case MOS_IQS7211A_SLIDE_Y_INCREASE:
            return IQS_TERM_COLOR_YELLOW;
        case MOS_IQS7211A_SLIDE_Y_DECREASE:
            return IQS_TERM_COLOR_MAGENTA;
        case MOS_IQS7211A_SLIDE_NONE:
        default:
            return IQS_TERM_COLOR_RED;
    }
}

static const char *iqs_swipe_name_from_dom_id(int dom_id)
{
    switch (dom_id)
    {
        case -2:
            return "SWIPE_X_NEGATIVE";
        case 2:
            return "SWIPE_X_POSITIVE";
        case -1:
            return "SWIPE_Y_NEGATIVE";
        case 1:
            return "SWIPE_Y_POSITIVE";
        default:
            return NULL;
    }
}

static const char *iqs_dom_desc_from_dom_id(int dom_id)
{
    switch (dom_id)
    {
        case -2:
            return "dominant X- (finger X decreased)";
        case 2:
            return "dominant X+ (finger X increased)";
        case -1:
            return "dominant Y- (finger Y decreased)";
        case 1:
            return "dominant Y+ (finger Y increased)";
        default:
            return "dominant unknown";
    }
}

static bool iqs_watch_arg_verbose(const char *arg)
{
    if (arg == NULL)
    {
        return false;
    }

    return (strcmp(arg, "verbose") == 0) || (strcmp(arg, "v") == 0) || (strcmp(arg, "all") == 0);
}

static int cmd_iqs7211a_slide(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    int ret = mos_iqs7211a_init();
    if (ret != 0)
    {
        shell_error(shell, "iqs7211a slide: init failed %d", ret);
        return ret;
    }

    mos_iqs7211a_slide_direction_t d = MOS_IQS7211A_SLIDE_NONE;
    bool valid = false;
    uint8_t conf = 0;
    uint32_t seq = 0;
    ret = mos_touch_app_get_last_final_gesture_event(&d, &valid, &conf, &seq);
    if (ret != 0)
    {
        shell_error(shell, "iqs7211a slide: touch_app not ready (%d)", ret);
        return 0;
    }

    shell_print(shell, "Final: %s  valid=%u confidence=%u seq=%u", iqs_slide_dir_str(d), (unsigned)valid,
                (unsigned)conf, (unsigned)seq);
    return 0;
}

static int cmd_iqs7211a_watch(const struct shell *shell, size_t argc, char **argv)
{
    int seconds = 10;
    bool watch_verbose_info = false;

    if (argc >= 2 && argv[1])
    {
        if (iqs_watch_arg_verbose(argv[1]))
        {
            watch_verbose_info = true;
        }
        else
        {
            seconds = atoi(argv[1]);
            if (seconds <= 0)
            {
                seconds = 10;
            }
        }
    }
    if (argc >= 3 && argv[2] && iqs_watch_arg_verbose(argv[2]))
    {
        watch_verbose_info = true;
    }

    shell_print(shell, "Watching RDY cache for %d s...", seconds);
    shell_print(shell,
                "Note: GESTURE_ENABLE is set at init; chip swipe bits often assert on lift/end of stroke, not every "
                "sample while dragging. SlideDir uses driver FINGER1 deltas.");
    if (!watch_verbose_info)
    {
        shell_print(shell, "Tip: ATI/Trackpad edge logs are hidden by default. Use: iqs7211a watch <s> verbose");
    }

    uint16_t last_gestures = 0xFFFF;
    uint16_t last_info = 0xFFFF;
    uint16_t last_f1x = 0xFFFF;
    uint16_t last_f1y = 0xFFFF;
    uint16_t last_relx = 0xFFFF;
    uint16_t last_rely = 0xFFFF;
    uint16_t prev_fx = 0xFFFF;
    uint16_t prev_fy = 0xFFFF;
    int32_t cum_dx = 0;
    int32_t cum_dy = 0;
    int last_dom_id = 0; /* -2:X- -1:Y- 1:Y+ 2:X+ */
    int axis_lock = 0; /* 0:unlocked 1:X 2:Y */
    int32_t lock_cum_dx = 0;
    int32_t lock_cum_dy = 0;
    int inferred_locked_dom_id = 0; /* locked inferred direction for current touch */

    /* Poll cached RDY updates at higher rate to avoid missing set/clear pulses. */
    const int poll_ms = 20;
    int loops = (seconds * 1000) / poll_ms;
    uint32_t last_final_event_seq = 0;
    const char *last_inferred_swipe = NULL;

    (void)mos_touch_app_get_last_final_gesture_event(NULL, NULL, NULL, &last_final_event_seq);

    for (int i = 0; i < loops; i++)
    {
        uint16_t gestures = 0;
        uint16_t info = 0;
        uint16_t f1x = 0;
        uint16_t f1y = 0;
        uint16_t relx = 0;
        uint16_t rely = 0;
        int ret = mos_iqs7211a_get_last_runtime_data(&gestures, &info, &f1x, &f1y, &relx, &rely);
        if (ret == 0)
        {
            /* SlideDir from driver was moved to mos_touch_app (policy layer). */

            /* Do not print in-flight direction estimation; only report final event after finger release. */

            {
                mos_iqs7211a_slide_direction_t event_dir = MOS_IQS7211A_SLIDE_NONE;
                bool event_valid = false;
                uint8_t event_conf = 0;
                uint32_t event_seq = last_final_event_seq;

                if (mos_touch_app_get_last_final_gesture_event(&event_dir, &event_valid, &event_conf, &event_seq) == 0)
                {
                    if (event_seq != last_final_event_seq)
                    {
                        if (event_valid)
                        {
                            shell_print(shell, "%s%s Final gesture: %s (%s, confidence=%u)%s",
                                        iqs_final_gesture_color(event_dir, true),
                                        iqs_final_gesture_icon(event_dir, true), iqs_slide_dir_str(event_dir),
                                        iqs_final_gesture_label(event_dir, true), (unsigned int)event_conf,
                                        IQS_TERM_COLOR_RESET);
                        }
                        else
                        {
                            shell_print(shell,
                                        "%s%s Final gesture: NONE (insufficient stroke or ambiguous direction)%s",
                                        iqs_final_gesture_color(MOS_IQS7211A_SLIDE_NONE, false),
                                        iqs_final_gesture_icon(MOS_IQS7211A_SLIDE_NONE, false), IQS_TERM_COLOR_RESET);
                        }

                        last_final_event_seq = event_seq;
                    }
                }
            }

            const uint8_t num_fingers_now = (uint8_t)((info >> 8) & 0x03u);
            const bool finger_valid = (f1x != 0xFFFFu && f1y != 0xFFFFu);
            const bool tracking_valid = finger_valid && (num_fingers_now > 0u);

            if (tracking_valid && (prev_fx != 0xFFFFu) && (prev_fy != 0xFFFFu))
            {
                int32_t dx = (int32_t)f1x - (int32_t)prev_fx;
                int32_t dy = (int32_t)f1y - (int32_t)prev_fy;
                if ((labs((long)dx) >= IQS_WATCH_MOVE_THRESH) || (labs((long)dy) >= IQS_WATCH_MOVE_THRESH))
                {
                    const char *dom;
                    int dom_id = 0;
                    if (labs((long)dx) >= labs((long)dy))
                    {
                        if (dx < 0)
                        {
                            dom = "dominant X- (finger X decreased)";
                            dom_id = -2;
                        }
                        else if (dx > 0)
                        {
                            dom = "dominant X+ (finger X increased)";
                            dom_id = 2;
                        }
                        else
                        {
                            dom = "X unchanged (see dY)";
                            dom_id = (dy < 0) ? -1 : 1;
                        }
                    }
                    else if (dy < 0)
                    {
                        dom = "dominant Y- (finger Y decreased)";
                        dom_id = -1;
                    }
                    else if (dy > 0)
                    {
                        dom = "dominant Y+ (finger Y increased)";
                        dom_id = 1;
                    }
                    else
                    {
                        dom = "Y unchanged";
                    }

                    lock_cum_dx += dx;
                    lock_cum_dy += dy;
                    if (axis_lock == 0)
                    {
                        long adx_lock = labs((long)lock_cum_dx);
                        long ady_lock = labs((long)lock_cum_dy);
                        bool lock_ready =
                            (adx_lock >= IQS_WATCH_AXIS_LOCK_THRESH) || (ady_lock >= IQS_WATCH_AXIS_LOCK_THRESH);
                        bool x_dominant =
                            (adx_lock * IQS_WATCH_AXIS_LOCK_RATIO_DEN) >= (ady_lock * IQS_WATCH_AXIS_LOCK_RATIO_NUM);
                        bool y_dominant =
                            (ady_lock * IQS_WATCH_AXIS_LOCK_RATIO_DEN) >= (adx_lock * IQS_WATCH_AXIS_LOCK_RATIO_NUM);

                        if (lock_ready && (x_dominant || y_dominant))
                        {
                            axis_lock = x_dominant ? 1 : 2;
                        }
                    }

                    if (axis_lock != 0)
                    {
                        int32_t axis_cum = (axis_lock == 1) ? lock_cum_dx : lock_cum_dy;
                        int candidate = 0;
                        if (axis_lock == 1)
                        {
                            candidate = (axis_cum < 0) ? -2 : (axis_cum > 0) ? 2 : 0;
                        }
                        else
                        {
                            candidate = (axis_cum < 0) ? -1 : (axis_cum > 0) ? 1 : 0;
                        }

                        if ((inferred_locked_dom_id == 0) && (labs((long)axis_cum) >= IQS_WATCH_AXIS_LOCK_THRESH))
                        {
                            inferred_locked_dom_id = candidate;
                        }
                        else if ((inferred_locked_dom_id != 0) && (candidate != 0)
                                 && (candidate != inferred_locked_dom_id)
                                 && (labs((long)axis_cum) >= IQS_WATCH_AXIS_REVERSE_THRESH))
                        {
                            inferred_locked_dom_id = candidate;
                        }
                    }

                    const char *inferred = iqs_swipe_name_from_dom_id(inferred_locked_dom_id);
                    int32_t inferred_axis_abs = 0;
                    int32_t inferred_cross_abs = 0;
                    if (axis_lock == 1)
                    {
                        inferred_axis_abs = (int32_t)labs((long)lock_cum_dx);
                        inferred_cross_abs = (int32_t)labs((long)lock_cum_dy);
                    }
                    else if (axis_lock == 2)
                    {
                        inferred_axis_abs = (int32_t)labs((long)lock_cum_dy);
                        inferred_cross_abs = (int32_t)labs((long)lock_cum_dx);
                    }
                    bool infer_dom_ok = (inferred_axis_abs * IQS_WATCH_INFER_DOM_RATIO_DEN)
                                        >= (inferred_cross_abs * IQS_WATCH_INFER_DOM_RATIO_NUM);
                    /* Fallback classifier with axis lock: avoid X/Y switching within one touch sequence. */
                    if ((inferred != NULL) && (inferred_axis_abs >= IQS_WATCH_INFER_EMIT_THRESH) && infer_dom_ok
                        && ((last_inferred_swipe == NULL) || (strcmp(last_inferred_swipe, inferred) != 0)))
                    {
                        shell_print(shell, "Gesture: %s (inferred from FINGER1 delta)", inferred);
                        last_inferred_swipe = inferred;
                    }

                    int log_dom_id = (inferred_locked_dom_id != 0) ? inferred_locked_dom_id : dom_id;
                    const char *log_dom = (inferred_locked_dom_id != 0) ? iqs_dom_desc_from_dom_id(log_dom_id) : dom;

                    cum_dx += dx;
                    cum_dy += dy;
                    bool dom_changed = (log_dom_id != 0) && (log_dom_id != last_dom_id);
                    bool cum_reached = (labs((long)cum_dx) >= IQS_WATCH_CUM_MOVE_LOG_THRESH)
                                       || (labs((long)cum_dy) >= IQS_WATCH_CUM_MOVE_LOG_THRESH);

                    if (dom_changed || cum_reached)
                    {
                        shell_print(shell, "Finger delta: dX=%ld dY=%ld (%s) cum=(%ld,%ld)", (long)dx, (long)dy,
                                    log_dom, (long)cum_dx, (long)cum_dy);
                    }

                    if (log_dom_id != 0)
                    {
                        last_dom_id = log_dom_id;
                    }
                    if (cum_reached)
                    {
                        cum_dx = 0;
                        cum_dy = 0;
                    }
                }
            }
            if (tracking_valid)
            {
                prev_fx = f1x;
                prev_fy = f1y;
            }
            else
            {
                prev_fx = 0xFFFFu;
                prev_fy = 0xFFFFu;
                cum_dx = 0;
                cum_dy = 0;
                last_dom_id = 0;
                axis_lock = 0;
                lock_cum_dx = 0;
                lock_cum_dy = 0;
                inferred_locked_dom_id = 0;
                last_inferred_swipe = NULL;
            }

            const bool active_frame = tracking_valid || (gestures != 0U);
            if (((gestures != last_gestures) || (info != last_info) || (f1x != last_f1x) || (f1y != last_f1y)
                 || (relx != last_relx) || (rely != last_rely))
                && (watch_verbose_info || active_frame))
            {
                shell_print(shell, "GEST=0x%04x INFO=0x%04x X=0x%04x Y=0x%04x REL_raw=0x%04x,0x%04x REL_s16=(%d,%d)",
                            gestures, info, f1x, f1y, relx, rely, (int)(int16_t)relx, (int)(int16_t)rely);
                last_gestures = gestures;
                last_info = info;
                last_f1x = f1x;
                last_f1y = f1y;
                last_relx = relx;
                last_rely = rely;
            }

            /* Decode INFO_FLAGS similar to Azoteq demo logs. */
            uint8_t info0 = (uint8_t)(info & 0x00FFu);
            uint8_t info1 = (uint8_t)((info >> 8) & 0x00FFu);
            uint8_t charging_mode = (uint8_t)(info0 & 0x07u);  // bits 0..2 标识充电模式
            uint8_t num_fingers = (uint8_t)(info1 & 0x03u);  // bits 8..9 标识手指数量
            bool tp_movement = !!(info1 & (1u << 2));  // bit 10 标识触控板是否有移动
            bool too_many_fingers = !!(info1 & (1u << 4));  // bit 12 标识检测到过多手指
            bool alp_output = !!(info1 & (1u << 6));  // bit 14 标识ALP输出
            bool ati_error = !!(info0 & (1u << 3));  // bit 3 标识ATI错误
            bool show_reset = !!(info0 & (1u << 7));  // bit 7 标识复位发生
            static uint16_t last_info_edge = 0xFFFFu;
            if (last_info_edge != info)
            {
                if (last_info_edge != 0xFFFFu)
                {
                    uint16_t changed = (uint16_t)(last_info_edge ^ info);
                    if (changed & (1u << 7))
                    {
                        shell_print(shell, "Reset Occurred %s", show_reset ? "set" : "cleared");
                    }
                    if (watch_verbose_info && (changed & (1u << 3)))
                    {
                        shell_print(shell, "ATI Error %s", ati_error ? "set" : "cleared");
                    }
                    if (watch_verbose_info && (changed & (1u << (8 + 2))))
                    {
                        shell_print(shell, "Trackpad Movement %s", tp_movement ? "set" : "cleared");
                    }
                    if (changed & (1u << (8 + 4)))
                    {
                        shell_print(shell, "Too Many Fingers %s", too_many_fingers ? "set" : "cleared");
                    }
                    if (changed & (1u << (8 + 6)))
                    {
                        shell_print(shell, "ALP Output %s", alp_output ? "set" : "cleared");
                    }
                    if (changed & (0x0003u << 8))
                    {
                        shell_print(shell, "Amount of Fingers switched to %u", num_fingers);
                    }
                    if (watch_verbose_info && (changed & 0x0007u))
                    {
                        const char *mode = (charging_mode == 0)   ? "Active Mode"
                                           : (charging_mode == 1) ? "Idle Touch Mode"
                                           : (charging_mode == 2) ? "Idle Mode"
                                           : (charging_mode == 3) ? "LP1 Mode"
                                           : (charging_mode == 4) ? "LP2 Mode"
                                                                  : "Unknown";
                        shell_print(shell, "Charging Mode switched to %s", mode);
                    }
                }
                last_info_edge = info;
            }

            static uint16_t last_gest_edge = 0;
            uint16_t rising = (uint16_t)(gestures & (uint16_t)~last_gest_edge);
            last_gest_edge = gestures;

            if (rising & 0x0001u)
            {
                shell_print(shell, "Gesture: SINGLE_TAP (bit0)");
            }
            if (rising & 0x0002u)
            {
                shell_print(shell, "Gesture: PRESS_HOLD (bit1)");
            }
            if (rising & 0x0004u)
            {
                shell_print(shell, "Gesture: SWIPE_X_NEGATIVE (bit2)");
            }
            if (rising & 0x0008u)
            {
                shell_print(shell, "Gesture: SWIPE_X_POSITIVE (bit3)");
            }
            if (rising & 0x0010u)
            {
                shell_print(shell, "Gesture: SWIPE_Y_POSITIVE (bit4)");
            }
            if (rising & 0x0020u)
            {
                shell_print(shell, "Gesture: SWIPE_Y_NEGATIVE (bit5)");
            }
            {
                uint16_t other = (uint16_t)(rising & (uint16_t)~0x003Fu);
                if (other != 0U)
                {
                    shell_print(shell, "Gesture: other GEST bits (rising 0x%04x)", other);
                }
            }
        }

        k_sleep(K_MSEC(poll_ms));
    }

    shell_print(shell, "Watch done.");
    (void)cmd_iqs7211a_stats(shell, 0, NULL);
    return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(
    sub_iqs7211a, SHELL_CMD(help, NULL, "Show IQS7211A commands help", cmd_iqs7211a_help),
    SHELL_CMD(id, NULL, "Read version details and print word[0]", cmd_iqs7211a_id),
    SHELL_CMD(ver, NULL, "Read version details and print all words (0x00..0x09)", cmd_iqs7211a_ver),
    SHELL_CMD(touch, NULL, "Read cached runtime (RDY)", cmd_iqs7211a_touch),
    SHELL_CMD(rdy_on, NULL, "Re-arm RDY GPIO interrupts", cmd_iqs7211a_rdy_on),
    SHELL_CMD(last, NULL, "Print cached runtime (RDY)", cmd_iqs7211a_last),
    SHELL_CMD(stats, NULL, "Print RDY interrupt/debug counters", cmd_iqs7211a_stats),
    SHELL_CMD(slide, NULL, "Print last slide direction from driver (FINGER1 deltas)", cmd_iqs7211a_slide),
    SHELL_CMD_ARG(watch, NULL, "Watch cache [sec] [verbose]: default hides ATI/Trackpad edge spam", cmd_iqs7211a_watch,
                  1, 2),
    SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(iqs7211a, &sub_iqs7211a, "IQS7211A touch/proximity control", cmd_iqs7211a_help);
