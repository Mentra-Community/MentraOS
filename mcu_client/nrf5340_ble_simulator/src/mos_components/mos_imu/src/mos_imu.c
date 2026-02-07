#include "mos_imu.h"

#include "mos_lsm6dsv16x.h"

#include <math.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(mos_imu, LOG_LEVEL_INF);

#define IMU_THREAD_PRIORITY 7
#define TASK_IMU_NAME "imu_thread"
#define MOS_IMU_PI 3.14159265358979323846f


K_THREAD_STACK_DEFINE(imu_stack_area, 2048);

typedef struct
{
    bool initialized;
    bool running;

    bool thread_should_run;
    struct k_thread thread_data;
    k_tid_t thread_handle;

    mos_imu_config_t cfg;

    mos_imu_event_cb_t cb;
    void *cb_user_data;

    float ax_f;
    float ay_f;
    float az_f;

    float pitch_deg;
    float roll_deg;

    bool look_up_armed;
} mos_imu_state_t;

static mos_imu_state_t s = {0};

static float calc_pitch_deg(float ax, float ay, float az)
{
    float denom = sqrtf((ay * ay) + (az * az));
    float rad = atan2f(-ax, denom);
    return rad * (180.0f / (float)MOS_IMU_PI);
}

static float calc_roll_deg(float ax, float ay, float az)
{
    float rad = atan2f(ay, az);
    return rad * (180.0f / (float)MOS_IMU_PI);
}

static float lpf(float prev, float x, float alpha)
{
    if (alpha <= 0.0f)
    {
        return prev;
    }
    if (alpha >= 1.0f)
    {
        return x;
    }
    return (alpha * x) + ((1.0f - alpha) * prev);
}

static void maybe_fire_events(void)
{
    if (s.look_up_armed)
    {
        if (s.pitch_deg >= s.cfg.look_up_on_threshold_deg)
        {
            s.look_up_armed = false;

            if (s.cb != NULL)
            {
                s.cb(MOS_IMU_EVENT_LOOK_UP_CROSSED, s.pitch_deg, s.cb_user_data);
            }

            LOG_INF("IMU event: LOOK_UP_CROSSED pitch=%.1f deg", (double)s.pitch_deg);
        }
    }
    else
    {
        if (s.pitch_deg <= s.cfg.look_up_off_threshold_deg)
        {
            s.look_up_armed = true;
        }
    }
}

static void imu_thread_fn(void *a, void *b, void *c)
{
    ARG_UNUSED(a);
    ARG_UNUSED(b);
    ARG_UNUSED(c);

    LOG_INF("IMU thread started");

    while (s.thread_should_run)
    {
        float ax, ay, az;
        float gx, gy, gz;

        int err = lsm6dsv16x_read_all(&ax, &ay, &az, &gx, &gy, &gz);
        if (err == 0)
        {
            float ax_m = ax;
            float ay_m = -az;
            float az_m = ay;
 
            s.ax_f = lpf(s.ax_f, ax_m, s.cfg.accel_lpf_alpha);
            s.ay_f = lpf(s.ay_f, ay_m, s.cfg.accel_lpf_alpha);
            s.az_f = lpf(s.az_f, az_m, s.cfg.accel_lpf_alpha);

            s.pitch_deg = calc_pitch_deg(s.ax_f, s.ay_f, s.az_f);
            s.roll_deg = calc_roll_deg(s.ax_f, s.ay_f, s.az_f);

            LOG_DBG("IMU: pitch=%.1f deg, roll=%.1f deg", (double)s.pitch_deg, (double)s.roll_deg);

            maybe_fire_events();
        }

        k_msleep(s.cfg.sample_period_ms);
    }

    LOG_INF("IMU thread exiting");
}

int mos_imu_init(void)
{
    if (s.initialized)
    {
        return 0;
    }

    s.cfg.look_up_on_threshold_deg = 25.0f;
    s.cfg.look_up_off_threshold_deg = 20.0f;
    s.cfg.sample_period_ms = 50;
    s.cfg.accel_lpf_alpha = 0.25f;

    s.ax_f = 0.0f;
    s.ay_f = 0.0f;
    s.az_f = 9.8f;

    s.pitch_deg = 0.0f;
    s.roll_deg = 0.0f;

    s.look_up_armed = true;

    s.thread_handle = NULL;
    s.thread_should_run = false;
    s.running = false;

    s.initialized = true;
    return 0;
}

int mos_imu_set_config(const mos_imu_config_t *cfg)
{
    if (!s.initialized || cfg == NULL)
    {
        return -EINVAL;
    }

    mos_imu_config_t tmp = *cfg;

    if (tmp.look_up_off_threshold_deg >= tmp.look_up_on_threshold_deg)
    {
        tmp.look_up_off_threshold_deg = tmp.look_up_on_threshold_deg - 5.0f;
    }

    if (tmp.sample_period_ms == 0)
    {
        tmp.sample_period_ms = 50;
    }

    if (tmp.accel_lpf_alpha < 0.0f)
    {
        tmp.accel_lpf_alpha = 0.0f;
    }
    if (tmp.accel_lpf_alpha > 1.0f)
    {
        tmp.accel_lpf_alpha = 1.0f;
    }

    s.cfg = tmp;
    return 0;
}

int mos_imu_get_config(mos_imu_config_t *cfg)
{
    if (!s.initialized || cfg == NULL)
    {
        return -EINVAL;
    }

    *cfg = s.cfg;
    return 0;
}

int mos_imu_register_callback(mos_imu_event_cb_t cb, void *user_data)
{
    if (!s.initialized)
    {
        return -EINVAL;
    }

    s.cb = cb;
    s.cb_user_data = user_data;
    return 0;
}

int mos_imu_start(void)
{
    if (!s.initialized)
    {
        return -EINVAL;
    }

    if (s.running)
    {
        return 0;
    }

    s.thread_should_run = true;

    s.thread_handle = k_thread_create(&s.thread_data,
                                      imu_stack_area,
                                      K_THREAD_STACK_SIZEOF(imu_stack_area),
                                      imu_thread_fn,
                                      NULL, NULL, NULL,
                                      IMU_THREAD_PRIORITY,
                                      0,
                                      K_NO_WAIT);

    if (s.thread_handle == NULL)
    {
        s.thread_should_run = false;
        return -ENOMEM;
    }

    k_thread_name_set(s.thread_handle, TASK_IMU_NAME);

    s.running = true;
    return 0;
}

int mos_imu_stop(void)
{
    if (!s.running)
    {
        return 0;
    }

    s.thread_should_run = false;

    // If you need hard stop semantics:
    // k_thread_abort(s.thread_handle);

    s.running = false;
    return 0;
}

float mos_imu_get_pitch_deg(void)
{
    return s.pitch_deg;
}

float mos_imu_get_roll_deg(void)
{
    return s.roll_deg;
}

int mos_imu_thread_start(mos_imu_event_cb_t cb, void *user_data)
{
    int err;

    err = lsm6dsv16x_init();
    if (err != 0)
    {
        LOG_ERR("mos_imu_thread_start: lsm6dsv16x_init failed: %d", err);
        return err;
    }

    err = mos_imu_init();
    if (err != 0)
    {
        LOG_ERR("mos_imu_thread_start: mos_imu_init failed: %d", err);
        return err;
    }

    err = mos_imu_register_callback(cb, user_data);
    if (err != 0)
    {
        LOG_ERR("mos_imu_thread_start: mos_imu_register_callback failed: %d", err);
        return err;
    }

    LOG_INF("mos_imu_thread_start: starting IMU thread");

    return mos_imu_start();
}

int mos_imu_thread_start_with_config(const mos_imu_config_t *cfg,
                                     mos_imu_event_cb_t cb,
                                     void *user_data)
{
    int err;

    LOG_INF("mos_imu_thread_start_with_config: starting IMU thread");

    err = lsm6dsv16x_init();
    if (err != 0)
    {
        LOG_ERR("mos_imu_thread_start_with_config: lsm6dsv16x_init failed: %d", err);
        return err;
    }

    LOG_INF("mos_imu_thread_start_with_config: mos_imu_init");

    err = mos_imu_init();
    if (err != 0)
    {
        LOG_ERR("mos_imu_thread_start_with_config: mos_imu_init failed: %d", err);
        return err;
    }

    if (cfg != NULL)
    {
        LOG_INF("mos_imu_thread_start_with_config: mos_imu_set_config");
        err = mos_imu_set_config(cfg);
        if (err != 0)
        {
            LOG_ERR("mos_imu_thread_start_with_config: mos_imu_set_config failed: %d", err);
            return err;
        }
    }

    LOG_INF("mos_imu_thread_start_with_config: mos_imu_register_callback");
    err = mos_imu_register_callback(cb, user_data);
    if (err != 0)
    {
        LOG_ERR("mos_imu_thread_start_with_config: mos_imu_register_callback failed: %d", err);
        return err;
    }

    LOG_INF("mos_imu_thread_start_with_config: starting IMU thread");

    return mos_imu_start();
}