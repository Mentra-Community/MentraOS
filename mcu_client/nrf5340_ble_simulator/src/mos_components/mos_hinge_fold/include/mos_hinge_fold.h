#ifndef MOS_HINGE_FOLD_H_
#define MOS_HINGE_FOLD_H_

#include <stdbool.h>
#include <stdint.h>

typedef enum
{
    MOS_HINGE_STATE_UNKNOWN = 0,
    MOS_HINGE_STATE_OPEN,
    MOS_HINGE_STATE_FOLDED,
} mos_hinge_state_t;

typedef enum
{
    MOS_HINGE_EVENT_NONE = 0,
    MOS_HINGE_EVENT_OPENED,
    MOS_HINGE_EVENT_FOLDED,
} mos_hinge_event_t;

typedef enum
{
    MOS_HINGE_AXIS_X = 0,
    MOS_HINGE_AXIS_Y,
    MOS_HINGE_AXIS_Z,
} mos_hinge_axis_t;

typedef struct
{
    mos_hinge_axis_t axis;
    bool             invert_axis;
    float            folded_max_angle_deg;
    float            open_min_angle_deg;
    float            still_gyro_dps;
    uint32_t         hold_time_ms;
} mos_hinge_fold_config_t;
/**
 * @brief Set the default configuration for mos_hinge_fold_init().
 *
 * @param config The configuration to set.
 */
void mos_hinge_fold_set_default_config(mos_hinge_fold_config_t* config);
/**
 * @brief Initialize the hinge fold detection system with the given configuration.
 *
 * @param config The configuration to use. If NULL, the default configuration will be used.
 * @return 0 on success, negative error code on failure.
 */
int mos_hinge_fold_init(const mos_hinge_fold_config_t* config);
/**
 * @brief Update the hinge fold state based on current sensor readings.
 *
 * @param state Output parameter to receive the current hinge state (optional).
 * @param event Output parameter to receive any hinge events (optional).
 * @param tilt_deg Output parameter to receive the current tilt angle in degrees (optional).
 * @return 0 on success, negative error code on failure.
 */
int mos_hinge_fold_update(mos_hinge_state_t* state, mos_hinge_event_t* event, float* tilt_deg);
/**
 * @brief Get the current hinge state.
 *
 * @return The current hinge state.
 */
mos_hinge_state_t mos_hinge_fold_get_state(void);

/**
 * @brief Start hinge fold business service in a dedicated thread.
 *
 * @param config Optional detector config. NULL uses default values.
 * @return 0 on success, negative error code on failure.
 */
int mos_hinge_fold_service_start(const mos_hinge_fold_config_t* config);

/**
 * @brief Stop hinge fold business service thread.
 *
 * @return 0 on success, negative error code on failure.
 */
int mos_hinge_fold_service_stop(void);

#endif /* MOS_HINGE_FOLD_H_ */
