#ifndef MOS_IMU_H_
#define MOS_IMU_H_

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum
{
    MOS_IMU_EVENT_LOOK_UP_CROSSED = 0,
} mos_imu_event_t;

typedef void (*mos_imu_event_cb_t)(mos_imu_event_t event, float pitch_deg, void *user_data);

typedef struct
{
    float look_up_on_threshold_deg;   // fire when pitch rises above this
    float look_up_off_threshold_deg;  // re-arm when pitch falls below this (must be < on threshold)
    uint32_t sample_period_ms;        // e.g. 50ms -> 20Hz
    float accel_lpf_alpha;            // 0..1 (higher = less smoothing)
} mos_imu_config_t;

int mos_imu_init(void);
int mos_imu_start(void);
int mos_imu_stop(void);

int mos_imu_set_config(const mos_imu_config_t *cfg);
int mos_imu_get_config(mos_imu_config_t *cfg);

int mos_imu_register_callback(mos_imu_event_cb_t cb, void *user_data);

float mos_imu_get_pitch_deg(void);
float mos_imu_get_roll_deg(void);

/**
 * One-call convenience entrypoint:
 * - inits the IMU driver
 * - inits mos_imu
 * - registers callback
 * - starts the imu thread
 */
int mos_imu_thread_start(mos_imu_event_cb_t cb, void *user_data);

/**
 * Same as mos_imu_thread_start(), but allows overriding config (pass NULL to use defaults).
 */
int mos_imu_thread_start_with_config(const mos_imu_config_t *cfg,
                                    mos_imu_event_cb_t cb,
                                    void *user_data);

#ifdef __cplusplus
}
#endif

#endif // MOS_IMU_H_