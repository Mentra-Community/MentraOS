#include "mos_hinge_fold.h"

#include <display/lcd/a6n.h>
#include <errno.h>
#include <math.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "mos_lsm6dsv16x.h"
#include "mos_lvgl_display.h"

LOG_MODULE_REGISTER(mos_hinge_fold, LOG_LEVEL_INF);
#define MOS_HINGE_THREAD_STACK_SIZE 4096
#define MOS_HINGE_THREAD_PRIORITY 8
#define MOS_HINGE_STARTUP_GUARD_MS 8000U

#define MOS_HINGE_RAD_TO_DEG 57.2957795f // 弧度转角度的系数; coefficient for converting radians to degrees
#define MOS_HINGE_MIN_ACCEL_NORM 0.1f // 最小加速度模值，用于滤除噪声; minimum acceleration norm to filter out noise
#define MOS_HINGE_SERVICE_POLL_MS 100U // 服务轮询间隔，单位毫秒; service polling interval in milliseconds
#define MOS_HINGE_G_REF 9.80665f // 标准重力加速度，单位m/s²; standard gravity acceleration in m/s²
#define MOS_HINGE_MIN_ACCEL_NORM_SQ 16.0f // 最小加速度模值的平方，用于滤除噪声; minimum acceleration norm squared to filter out noise
#define MOS_HINGE_LOG_PERIOD_MS 1000U // 日志记录周期，单位毫秒; log period in milliseconds


static const mos_hinge_fold_config_t mos_hinge_default_config = {
    .axis = MOS_HINGE_AXIS_Z, // 默认使用 Z 轴（垂直轴）进行折叠检测;default to Z axis (vertical axis) for fold detection
    .invert_axis = false, // 不反转轴，保持原始加速度方向;do not invert axis, keep original acceleration direction
    .folded_max_angle_deg = 35.0f, // 折叠状态最大角度：35度以下视为折叠;below 35 degrees is considered folded
    .open_min_angle_deg = 55.0f, // 打开状态最小角度：55度以上视为打开，折叠和打开之间的20度为死区，防止抖动; above 55 degrees is considered open, 20 degrees dead zone between folded and open to prevent jitter
    .still_gyro_dps = 12.0f, // 陀螺仪静止阈值：12度/秒以下视为静止，帮助区分折叠/打开状态与正在移动状态; below 12 degrees/second is considered still, helps differentiate folded/open states from moving states
    .hold_time_ms = 800U, // 状态保持时间：800毫秒，要求状态持续至少800ms才确认状态变化，防止短暂抖动导致误判; state hold time: 800ms, requires the state to persist for at least 800ms to confirm state change, prevents false triggers from brief jitter
};

static mos_hinge_fold_config_t  mos_hinge_config;
static bool                     mos_hinge_config_valid;
static mos_hinge_state_t        mos_hinge_state = MOS_HINGE_STATE_UNKNOWN;
static mos_hinge_state_t        mos_hinge_pending = MOS_HINGE_STATE_UNKNOWN;
static int64_t                  mos_hinge_pending_since_ms;

static K_THREAD_STACK_DEFINE(mos_hinge_thread_stack, MOS_HINGE_THREAD_STACK_SIZE);
static struct k_thread mos_hinge_thread_data;
static k_tid_t         mos_hinge_thread_tid;
static bool            mos_hinge_thread_running;
static bool            mos_hinge_rest_mode;
static bool            mos_hinge_open_seen;
static int64_t         mos_hinge_service_start_ms;
static int64_t         mos_hinge_last_log_ms;

static float mos_hinge_clampf(float value, float min_v, float max_v)
{
    if (value < min_v)
    {
        return min_v;
    }

    if (value > max_v)
    {
        return max_v;
    }

    return value;
}

static float mos_hinge_select_axis_component(float x, float y, float z, mos_hinge_axis_t axis)
{
    switch (axis)
    {
        case MOS_HINGE_AXIS_X:
            return x;
        case MOS_HINGE_AXIS_Y:
            return y;
        case MOS_HINGE_AXIS_Z:
            return z;
        default:
            return y;
    }
}

static bool mos_hinge_config_is_valid(const mos_hinge_fold_config_t *config)
{
    if (config == NULL)
    {
        return false;
    }

    if (config->axis > MOS_HINGE_AXIS_Z)
    {
        return false;
    }

    if (config->folded_max_angle_deg < 0.0f || config->folded_max_angle_deg > 180.0f)
    {
        return false;
    }

    if (config->open_min_angle_deg < 0.0f || config->open_min_angle_deg > 180.0f)
    {
        return false;
    }

    if (config->open_min_angle_deg <= config->folded_max_angle_deg)
    {
        return false;
    }

    if (config->still_gyro_dps <= 0.0f)
    {
        return false;
    }

    if (config->hold_time_ms == 0U)
    {
        return false;
    }

    return true;
}

void mos_hinge_fold_set_default_config(mos_hinge_fold_config_t *config)
{
    if (config != NULL)
    {
        *config = mos_hinge_default_config;
    }
}

int mos_hinge_fold_init(const mos_hinge_fold_config_t *config)
{
    if (config == NULL)
    {
        mos_hinge_config = mos_hinge_default_config;
    }
    else
    {
        if (!mos_hinge_config_is_valid(config))
        {
            LOG_ERR("Invalid hinge fold config");
            return -EINVAL;
        }

        mos_hinge_config = *config;
    }

    mos_hinge_config_valid = true;
    mos_hinge_state = MOS_HINGE_STATE_UNKNOWN;
    mos_hinge_pending = MOS_HINGE_STATE_UNKNOWN;
    mos_hinge_pending_since_ms = 0;

    LOG_INF("Hinge fold init: axis=%d invert=%d folded<=%.1fdeg open>=%.1fdeg still<=%.1fdps hold=%ums",
            mos_hinge_config.axis, mos_hinge_config.invert_axis, (double)mos_hinge_config.folded_max_angle_deg,
            (double)mos_hinge_config.open_min_angle_deg, (double)mos_hinge_config.still_gyro_dps,
            mos_hinge_config.hold_time_ms);

    return 0;
}

int mos_hinge_fold_update(mos_hinge_state_t *state, mos_hinge_event_t *event, float *tilt_deg)
{
    float accel_x;
    float accel_y;
    float accel_z;
    float gyro_x;
    float gyro_y;
    float gyro_z;
    float axis_component;
    float accel_norm_sq;
    float gyro_abs_sq;
    float folded_axis_thresh;
    float open_axis_thresh;
    int64_t now_ms;
    mos_hinge_state_t candidate = MOS_HINGE_STATE_UNKNOWN;
    int ret;

    if (!mos_hinge_config_valid)
    {
        ret = mos_hinge_fold_init(NULL);
        if (ret != 0)
        {
            return ret;
        }
    }

    if (event != NULL)
    {
        *event = MOS_HINGE_EVENT_NONE;
    }

    ret = lsm6dsv16x_read_all(&accel_x, &accel_y, &accel_z, &gyro_x, &gyro_y, &gyro_z);
    if (ret != 0)
    {
        return ret;
    }

    accel_norm_sq = accel_x * accel_x + accel_y * accel_y + accel_z * accel_z;
    if (accel_norm_sq < MOS_HINGE_MIN_ACCEL_NORM_SQ)
    {
        return -EAGAIN;
    }

    axis_component = mos_hinge_select_axis_component(accel_x, accel_y, accel_z, mos_hinge_config.axis);
    if (mos_hinge_config.invert_axis)
    {
        axis_component = -axis_component;
    }

    /* Convert configured angle thresholds to axis acceleration thresholds using 1g projection */
    folded_axis_thresh = MOS_HINGE_G_REF * 0.82f; /* cos(35deg) ~= 0.819 */
    open_axis_thresh = MOS_HINGE_G_REF * 0.57f;   /* cos(55deg) ~= 0.574 */

    gyro_abs_sq = gyro_x * gyro_x + gyro_y * gyro_y + gyro_z * gyro_z;

    if (tilt_deg != NULL)
    {
        *tilt_deg = -1.0f;
    }

    if (gyro_abs_sq <= (mos_hinge_config.still_gyro_dps * mos_hinge_config.still_gyro_dps))
    {
        if (axis_component >= folded_axis_thresh)
        {
            candidate = MOS_HINGE_STATE_FOLDED;
        }
        else if (axis_component <= open_axis_thresh)
        {
            candidate = MOS_HINGE_STATE_OPEN;
        }
    }

    now_ms = k_uptime_get();

    if (candidate == MOS_HINGE_STATE_UNKNOWN)
    {
        mos_hinge_pending = MOS_HINGE_STATE_UNKNOWN;
    }
    else if (candidate != mos_hinge_pending)
    {
        mos_hinge_pending = candidate;
        mos_hinge_pending_since_ms = now_ms;
    }
    else if ((now_ms - mos_hinge_pending_since_ms) >= (int64_t)mos_hinge_config.hold_time_ms)
    {
        if (mos_hinge_state != candidate)
        {
            mos_hinge_state = candidate;
            if (event != NULL)
            {
                *event = (candidate == MOS_HINGE_STATE_FOLDED) ? MOS_HINGE_EVENT_FOLDED : MOS_HINGE_EVENT_OPENED;
            }
        }
    }

    if (state != NULL)
    {
        *state = mos_hinge_state;
    }

    return 0;
}

mos_hinge_state_t mos_hinge_fold_get_state(void)
{
    return mos_hinge_state;
}


static void mos_hinge_fold_service_thread(void *p1, void *p2, void *p3)
{
    ARG_UNUSED(p1);
    ARG_UNUSED(p2);
    ARG_UNUSED(p3);

    LOG_INF("Hinge fold service thread started");
    mos_hinge_service_start_ms = k_uptime_get();
    mos_hinge_last_log_ms = mos_hinge_service_start_ms;

    while (mos_hinge_thread_running)
    {
        mos_hinge_state_t state = MOS_HINGE_STATE_UNKNOWN;
        mos_hinge_event_t event = MOS_HINGE_EVENT_NONE;
        float tilt_deg = 0.0f;
        int ret;

        ret = mos_hinge_fold_update(&state, &event, &tilt_deg);
        if (ret == 0)
        {
            int64_t now_ms = k_uptime_get();

            if (state == MOS_HINGE_STATE_OPEN)
            {
                mos_hinge_open_seen = true;
            }

            bool startup_guard = (now_ms - mos_hinge_service_start_ms) < MOS_HINGE_STARTUP_GUARD_MS;
            bool fold_action_allowed = mos_hinge_open_seen && !startup_guard;
            if (event == MOS_HINGE_EVENT_FOLDED)
            {
                LOG_INF("Hinge event: FOLDED (guard=%d, open_seen=%d, action_allowed=%d)",
                        startup_guard, mos_hinge_open_seen, fold_action_allowed);

                if (!mos_hinge_rest_mode && fold_action_allowed)
                {
                    set_display_onoff(false);
                    a6n_power_off();
                    a6n_io_off();
                    mos_hinge_rest_mode = true;
                    LOG_INF("Hinge folded -> rest mode entered");
                }
            }
            else if (event == MOS_HINGE_EVENT_OPENED)
            {
                LOG_INF("Hinge event: OPENED (guard=%d, open_seen=%d)", startup_guard, mos_hinge_open_seen);

                if (mos_hinge_rest_mode)
                {
                    display_open();             
                    set_display_onoff(true);
                    mos_hinge_rest_mode = false;
                    LOG_INF("Hinge opened -> rest mode exited");
                }
            }

            if ((now_ms - mos_hinge_last_log_ms) >= MOS_HINGE_LOG_PERIOD_MS)
            {
                LOG_INF("Hinge monitor: state=%d guard=%d open_seen=%d rest=%d",
                        state, startup_guard, mos_hinge_open_seen, mos_hinge_rest_mode);
                mos_hinge_last_log_ms = now_ms;
            }
        }
        else if (ret != -EAGAIN)
        {
            LOG_WRN("mos_hinge_fold_update failed: %d", ret);
        }

        k_sleep(K_MSEC(MOS_HINGE_SERVICE_POLL_MS));
    }

    LOG_INF("Hinge fold service thread stopped");
}

int mos_hinge_fold_service_start(const mos_hinge_fold_config_t *config)
{
    int ret;

    if (mos_hinge_thread_running)
    {
        return 0;
    }

    ret = mos_hinge_fold_init(config);
    if (ret != 0)
    {
        return ret;
    }

    mos_hinge_rest_mode = false;
    mos_hinge_open_seen = false;
    mos_hinge_service_start_ms = 0;
    mos_hinge_last_log_ms = 0;
    mos_hinge_thread_running = true;

    int thread_options = 0;
#if defined(CONFIG_FPU)
    thread_options |= K_FP_REGS;
#endif

    mos_hinge_thread_tid = k_thread_create(&mos_hinge_thread_data, 
                                            mos_hinge_thread_stack,
                                            K_THREAD_STACK_SIZEOF(mos_hinge_thread_stack),
                                            mos_hinge_fold_service_thread, 
                                            NULL, NULL, NULL,
                                            MOS_HINGE_THREAD_PRIORITY, 
                                            thread_options, 
                                            K_NO_WAIT);

    if (mos_hinge_thread_tid == NULL)
    {
        mos_hinge_thread_running = false;
        return -ENOMEM;
    }

    k_thread_name_set(mos_hinge_thread_tid, "hinge_fold");
    return 0;
}

int mos_hinge_fold_service_stop(void)
{
    if (!mos_hinge_thread_running)
    {
        return 0;
    }

    mos_hinge_thread_running = false;

    if (mos_hinge_thread_tid != NULL)
    {
        k_thread_abort(mos_hinge_thread_tid);
        mos_hinge_thread_tid = NULL;
    }

    return 0;
}
