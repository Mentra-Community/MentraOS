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

/* ---------------- Quaternion mount compensation ---------------- */

typedef struct {
    float w, x, y, z;   // unit quaternion
    bool valid;
} mos_quat_t;

static mos_quat_t s_mount_q = { .w = 1.0f, .x = 0.0f, .y = 0.0f, .z = 0.0f, .valid = false };

static inline float inv_sqrtf_fast(float x) { return 1.0f / sqrtf(x); }

static inline void v3_norm(float *x, float *y, float *z)
{
    float n2 = (*x)*(*x) + (*y)*(*y) + (*z)*(*z);
    if (n2 > 1e-9f) {
        float invn = inv_sqrtf_fast(n2);
        *x *= invn; *y *= invn; *z *= invn;
    }
}

static inline float v3_dot(float ax,float ay,float az, float bx,float by,float bz)
{
    return ax*bx + ay*by + az*bz;
}

static inline void v3_cross(float ax,float ay,float az, float bx,float by,float bz,
                            float *cx,float *cy,float *cz)
{
    *cx = ay*bz - az*by;
    *cy = az*bx - ax*bz;
    *cz = ax*by - ay*bx;
}

static inline void quat_norm(mos_quat_t *q)
{
    float n2 = q->w*q->w + q->x*q->x + q->y*q->y + q->z*q->z;
    if (n2 > 1e-12f) {
        float invn = inv_sqrtf_fast(n2);
        q->w *= invn; q->x *= invn; q->y *= invn; q->z *= invn;
    }
}

// Quaternion that rotates unit vector a -> unit vector b
static mos_quat_t quat_from_two_unit_vecs(float ax,float ay,float az,
                                         float bx,float by,float bz)
{
    mos_quat_t q = {0};
    float cx, cy, cz;
    v3_cross(ax,ay,az, bx,by,bz, &cx,&cy,&cz);
    float d = v3_dot(ax,ay,az, bx,by,bz);

    // If vectors nearly opposite, choose an orthogonal axis (180° rotation)
    if (d < -0.9999f) {
        float ox = 1.0f, oy = 0.0f, oz = 0.0f;
        if (fabsf(ax) > 0.9f) { ox = 0.0f; oy = 1.0f; oz = 0.0f; }
        v3_cross(ax,ay,az, ox,oy,oz, &cx,&cy,&cz);
        v3_norm(&cx,&cy,&cz);
        q.w = 0.0f; q.x = cx; q.y = cy; q.z = cz;
        q.valid = true;
        return q;
    }

    // Standard case
    q.w = 1.0f + d;
    q.x = cx; q.y = cy; q.z = cz;
    quat_norm(&q);
    q.valid = true;
    return q;
}

// Rotate vector v by unit quaternion q: v' = q*v*q_conj (fast form)
static inline void quat_rotate_vec3(const mos_quat_t *q,
                                    float vx,float vy,float vz,
                                    float *rx,float *ry,float *rz)
{
    // t = 2 * cross(q.xyz, v)
    float tx = 2.0f * (q->y*vz - q->z*vy);
    float ty = 2.0f * (q->z*vx - q->x*vz);
    float tz = 2.0f * (q->x*vy - q->y*vx);

    // v' = v + q.w*t + cross(q.xyz, t)
    float cx = (q->y*tz - q->z*ty);
    float cy = (q->z*tx - q->x*tz);
    float cz = (q->x*ty - q->y*tx);

    *rx = vx + q->w*tx + cx;
    *ry = vy + q->w*ty + cy;
    *rz = vz + q->w*tz + cz;
}

/*
 * Calibrate mount compensation so that, at "neutral", gravity becomes (0,0,-1).
 * Call this once (e.g., at boot during development, or later via user action).
 */
static int mos_imu_calibrate_mount_neutral_to_minus_z(void)
{
    float sx = 0, sy = 0, sz = 0;
    const int N = 60;

    for (int i = 0; i < N; i++) {
        float ax, ay, az, gx, gy, gz;
        if (lsm6dsv16x_read_all(&ax, &ay, &az, &gx, &gy, &gz) != 0) {
            return -EIO;
        }

        // 1) Axis remap (your current mapping)
        float ax_m = ax;
        float ay_m = -az;
        float az_m = ay;

        sx += ax_m; sy += ay_m; sz += az_m;
        k_msleep(10);
    }

    float gx0 = sx / (float)N;
    float gy0 = sy / (float)N;
    float gz0 = sz / (float)N;
    v3_norm(&gx0, &gy0, &gz0);

    // 2) Reference gravity is -Z (as you expect)
    s_mount_q = quat_from_two_unit_vecs(gx0, gy0, gz0, 0.0f, 0.0f, -1.0f);

    LOG_INF("IMU mount calibrated (to -Z): q=[%.4f %.4f %.4f %.4f]",
            (double)s_mount_q.w, (double)s_mount_q.x, (double)s_mount_q.y, (double)s_mount_q.z);

    return 0;
}

/* ---------------- Your existing IMU module ---------------- */

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

// If you expect gravity ~ -Z at rest, using -az makes neutral roll near 0 (not ~180)
static float calc_roll_deg(float ax, float ay, float az)
{
    (void)ax;
    float rad = atan2f(ay, -az);
    return rad * (180.0f / (float)MOS_IMU_PI);
}

static float lpf(float prev, float x, float alpha)
{
    if (alpha <= 0.0f) return prev;
    if (alpha >= 1.0f) return x;
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
            // 1) Axis remap (chip -> your body/glasses frame)
            float ax_m = ax;
            float ay_m = -az;
            float az_m = ay;

            // 2) Mount compensation (tilt correction) if calibrated
            if (s_mount_q.valid) {
                float rx, ry, rz;
                quat_rotate_vec3(&s_mount_q, ax_m, ay_m, az_m, &rx, &ry, &rz);
                ax_m = rx; ay_m = ry; az_m = rz;
            }

            // 3) Filter in corrected frame
            s.ax_f = lpf(s.ax_f, ax_m, s.cfg.accel_lpf_alpha);
            s.ay_f = lpf(s.ay_f, ay_m, s.cfg.accel_lpf_alpha);
            s.az_f = lpf(s.az_f, az_m, s.cfg.accel_lpf_alpha);

            // 4) Angles
            s.pitch_deg = calc_pitch_deg(s.ax_f, s.ay_f, s.az_f);
            s.roll_deg  = calc_roll_deg(s.ax_f, s.ay_f, s.az_f);

            LOG_DBG("IMU: pitch=%.1f deg, roll=%.1f deg", (double)s.pitch_deg, (double)s.roll_deg);

            maybe_fire_events();
        }

        k_msleep(s.cfg.sample_period_ms);
    }

    LOG_INF("IMU thread exiting");
}

int mos_imu_init(void)
{
    if (s.initialized) return 0;

    s.cfg.look_up_on_threshold_deg = 25.0f;
    s.cfg.look_up_off_threshold_deg = 20.0f;
    s.cfg.sample_period_ms = 50;
    s.cfg.accel_lpf_alpha = 0.25f;

    s.ax_f = 0.0f;
    s.ay_f = 0.0f;
    s.az_f = -9.8f;   // you expect gravity on -Z

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
    if (!s.initialized || cfg == NULL) return -EINVAL;

    mos_imu_config_t tmp = *cfg;

    if (tmp.look_up_off_threshold_deg >= tmp.look_up_on_threshold_deg)
        tmp.look_up_off_threshold_deg = tmp.look_up_on_threshold_deg - 5.0f;

    if (tmp.sample_period_ms == 0) tmp.sample_period_ms = 50;

    if (tmp.accel_lpf_alpha < 0.0f) tmp.accel_lpf_alpha = 0.0f;
    if (tmp.accel_lpf_alpha > 1.0f) tmp.accel_lpf_alpha = 1.0f;

    s.cfg = tmp;
    return 0;
}

int mos_imu_get_config(mos_imu_config_t *cfg)
{
    if (!s.initialized || cfg == NULL) return -EINVAL;
    *cfg = s.cfg;
    return 0;
}

int mos_imu_register_callback(mos_imu_event_cb_t cb, void *user_data)
{
    if (!s.initialized) return -EINVAL;
    s.cb = cb;
    s.cb_user_data = user_data;
    return 0;
}

int mos_imu_start(void)
{
    if (!s.initialized) return -EINVAL;
    if (s.running) return 0;

    s.thread_should_run = true;

    s.thread_handle = k_thread_create(&s.thread_data,
                                      imu_stack_area,
                                      K_THREAD_STACK_SIZEOF(imu_stack_area),
                                      imu_thread_fn,
                                      NULL, NULL, NULL,
                                      IMU_THREAD_PRIORITY,
                                      0,
                                      K_NO_WAIT);

    if (s.thread_handle == NULL) {
        s.thread_should_run = false;
        return -ENOMEM;
    }

    k_thread_name_set(s.thread_handle, TASK_IMU_NAME);

    s.running = true;
    return 0;
}

int mos_imu_stop(void)
{
    if (!s.running) return 0;

    s.thread_should_run = false;
    // If you need hard stop semantics: k_thread_abort(s.thread_handle);

    s.running = false;
    return 0;
}

float mos_imu_get_pitch_deg(void) { return s.pitch_deg; }
float mos_imu_get_roll_deg(void)  { return s.roll_deg; }

int mos_imu_thread_start(mos_imu_event_cb_t cb, void *user_data)
{
    int err = lsm6dsv16x_init();
    if (err != 0) {
        LOG_ERR("mos_imu_thread_start: lsm6dsv16x_init failed: %d", err);
        return err;
    }

    err = mos_imu_init();
    if (err != 0) {
        LOG_ERR("mos_imu_thread_start: mos_imu_init failed: %d", err);
        return err;
    }

    // Calibrate once at boot for now (development). You can remove later.
    err = mos_imu_calibrate_mount_neutral_to_minus_z();
    if (err != 0) {
        LOG_WRN("IMU mount calibration skipped (err=%d). Using no mount compensation.", err);
        s_mount_q.valid = false;
    }

    err = mos_imu_register_callback(cb, user_data);
    if (err != 0) {
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
    if (err != 0) {
        LOG_ERR("mos_imu_thread_start_with_config: lsm6dsv16x_init failed: %d", err);
        return err;
    }

    err = mos_imu_init();
    if (err != 0) {
        LOG_ERR("mos_imu_thread_start_with_config: mos_imu_init failed: %d", err);
        return err;
    }

    if (cfg != NULL) {
        err = mos_imu_set_config(cfg);
        if (err != 0) {
            LOG_ERR("mos_imu_thread_start_with_config: mos_imu_set_config failed: %d", err);
            return err;
        }
    }

    // Calibrate once at boot for now (development). You can remove later.
    err = mos_imu_calibrate_mount_neutral_to_minus_z();
    if (err != 0) {
        LOG_WRN("IMU mount calibration skipped (err=%d). Using no mount compensation.", err);
        s_mount_q.valid = false;
    }

    err = mos_imu_register_callback(cb, user_data);
    if (err != 0) {
        LOG_ERR("mos_imu_thread_start_with_config: mos_imu_register_callback failed: %d", err);
        return err;
    }

    LOG_INF("mos_imu_thread_start_with_config: starting IMU thread");
    return mos_imu_start();
}
