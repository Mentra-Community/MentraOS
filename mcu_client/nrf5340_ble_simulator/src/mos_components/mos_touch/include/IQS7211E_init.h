/*
* This file contains all the necessary settings for the IQS7211E.
* It can be changed from the GUI or edited here.
* File:   IQS7211E_init.h
* Author: Azoteq
*/

#ifndef IQS7211E_INIT_H
#define IQS7211E_INIT_H

/* ALP ATI Compensation */
/* Memory Map Position 0x1F - 0x20 */
#define ALP_COMPENSATION_A_0                     0x13
#define ALP_COMPENSATION_A_1                     0x02
#define ALP_COMPENSATION_B_0                     0x43
#define ALP_COMPENSATION_B_1                     0x02

/* ATI Settings */
/* Memory Map Position 0x21 - 0x27 */
#define TP_ATI_MULTIPLIERS_DIVIDERS_0            0xE1
#define TP_ATI_MULTIPLIERS_DIVIDERS_1            0x09
#define TP_COMPENSATION_DIV                      0x08
#define TP_REF_DRIFT_LIMIT                       0x32
#define TP_ATI_TARGET_0                          0x2C
#define TP_ATI_TARGET_1                          0x01
#define TP_MIN_COUNT_REATI_0                     0x32
#define TP_MIN_COUNT_REATI_1                     0x00
#define ALP_ATI_MULTIPLIERS_DIVIDERS_0           0xA1
#define ALP_ATI_MULTIPLIERS_DIVIDERS_1           0x02
#define ALP_COMPENSATION_DIV                     0x02
#define ALP_LTA_DRIFT_LIMIT                      0x14
#define ALP_ATI_TARGET_0                         0xC8
#define ALP_ATI_TARGET_1                         0x00

/* Report Rates and Timing */
/* Memory Map Position 0x28 - 0x32 */
#define ACTIVE_MODE_REPORT_RATE_0                0x0A
#define ACTIVE_MODE_REPORT_RATE_1                0x00
#define IDLE_TOUCH_MODE_REPORT_RATE_0            0x80
#define IDLE_TOUCH_MODE_REPORT_RATE_1            0x00
#define IDLE_MODE_REPORT_RATE_0                  0x14
#define IDLE_MODE_REPORT_RATE_1                  0x00
#define LP1_MODE_REPORT_RATE_0                   0x30
#define LP1_MODE_REPORT_RATE_1                   0x00
#define LP2_MODE_REPORT_RATE_0                   0x60
#define LP2_MODE_REPORT_RATE_1                   0x00
#define ACTIVE_MODE_TIMEOUT_0                    0x04
#define ACTIVE_MODE_TIMEOUT_1                    0x00
#define IDLE_TOUCH_MODE_TIMEOUT_0                0x14
#define IDLE_TOUCH_MODE_TIMEOUT_1                0x00
#define IDLE_MODE_TIMEOUT_0                      0x04
#define IDLE_MODE_TIMEOUT_1                      0x00
#define LP1_MODE_TIMEOUT_0                       0x08
#define LP1_MODE_TIMEOUT_1                       0x00
#define REATI_RETRY_TIME                         0x05
#define REF_UPDATE_TIME                          0x08
#define I2C_TIMEOUT_0                            0x64
#define I2C_TIMEOUT_1                            0x00

/* System Settings */
/* Memory Map Position 0x33 - 0x35 */
#define SYSTEM_CONTROL_0                         0x00
#define SYSTEM_CONTROL_1                         0x00
#define CONFIG_SETTINGS0                         0x2C
#define CONFIG_SETTINGS1                         0x02
#define OTHER_SETTINGS_0                         0x00
#define OTHER_SETTINGS_1                         0x00

/* ALP Settings */
/* Memory Map Position 0x36 - 0x37 */
#define ALP_SETUP_0                              0x21
#define ALP_SETUP_1                              0x03
#define ALP_TX_ENABLE_0                          0x80
#define ALP_TX_ENABLE_1                          0x02

/* Thresholds and Debounce Settings */
/* Memory Map Position 0x38 - 0x3A */
#define TRACKPAD_TOUCH_SET_THRESHOLD             0x2C
#define TRACKPAD_TOUCH_CLEAR_THRESHOLD           0x28
#define ALP_THRESHOLD_0                          0x08
#define ALP_THRESHOLD_1                          0x00
#define ALP_SET_DEBOUNCE                         0x02
#define ALP_CLEAR_DEBOUNCE                       0x02

/* Button and ALP count and LTA betas */
/* Memory Map Position 0x3B - 0x3C */
#define ALP_COUNT_BETA_LP1                       0xDC
#define ALP_LTA_BETA_LP1                         0x08
#define ALP_COUNT_BETA_LP2                       0xF0
#define ALP_LTA_BETA_LP2                         0x10

/* Hardware Settings */
/* Memory Map Position 0x3D - 0x40 */
#define TP_CONVERSION_FREQUENCY_UP_PASS_LENGTH   0x02
#define TP_CONVERSION_FREQUENCY_FRACTION_VALUE   0x1A
#define ALP_CONVERSION_FREQUENCY_UP_PASS_LENGTH  0x02
#define ALP_CONVERSION_FREQUENCY_FRACTION_VALUE  0x1A
#define TRACKPAD_HARDWARE_SETTINGS_0             0x03
#define TRACKPAD_HARDWARE_SETTINGS_1             0x8C
#define ALP_HARDWARE_SETTINGS_0                  0x47
#define ALP_HARDWARE_SETTINGS_1                  0x9C

/* Trackpad Settings */
/* Memory Map Position 0x41 - 0x49 */
#define TRACKPAD_SETTINGS_0_0                    0x28
#define TRACKPAD_SETTINGS_0_1                    0x03
#define TRACKPAD_SETTINGS_1_0                    0x03
#define TRACKPAD_SETTINGS_1_1                    0x01
#define X_RESOLUTION_0                           0x00
#define X_RESOLUTION_1                           0x02
#define Y_RESOLUTION_0                           0x00
#define Y_RESOLUTION_1                           0x02
#define XY_DYNAMIC_FILTER_BOTTOM_SPEED_0         0x06
#define XY_DYNAMIC_FILTER_BOTTOM_SPEED_1         0x00
#define XY_DYNAMIC_FILTER_TOP_SPEED_0            0x7C
#define XY_DYNAMIC_FILTER_TOP_SPEED_1            0x00
#define XY_DYNAMIC_FILTER_BOTTOM_BETA            0x07
#define XY_DYNAMIC_FILTER_STATIC_FILTER_BETA     0x80
#define STATIONARY_TOUCH_MOV_THRESHOLD           0xC8
#define FINGER_SPLIT_FACTOR                      0x03
#define X_TRIM_VALUE                             0x0A
#define Y_TRIM_VALUE                             0x0A

/* Settings Version Numbers */
/* Memory Map Position 0x4A - 0x4A */
#define MINOR_VERSION                            0x00
#define MAJOR_VERSION                            0x00

/* Gesture Settings */
/* Memory Map Position 0x4B - 0x55 */
#define GESTURE_ENABLE_0                         0x0F
#define GESTURE_ENABLE_1                         0x0F
#define TAP_TOUCH_TIME_0                         0x2C
#define TAP_TOUCH_TIME_1                         0x01
#define TAP_WAIT_TIME_0                          0x2C
#define TAP_WAIT_TIME_1                          0x01
#define TAP_DISTANCE_0                           0x78
#define TAP_DISTANCE_1                           0x00
#define HOLD_TIME_0                              0xB8
#define HOLD_TIME_1                              0x0B
#define SWIPE_TIME_0                             0xF4
#define SWIPE_TIME_1                             0x01
#define SWIPE_X_DISTANCE_0                       0x40
#define SWIPE_X_DISTANCE_1                       0x01
#define SWIPE_Y_DISTANCE_0                       0x40
#define SWIPE_Y_DISTANCE_1                       0x01
#define SWIPE_X_CONS_DIST_0                      0xE8
#define SWIPE_X_CONS_DIST_1                      0x03
#define SWIPE_Y_CONS_DIST_0                      0xE8
#define SWIPE_Y_CONS_DIST_1                      0x03
#define SWIPE_ANGLE                              0x28
#define PALM_THRESHOLD                           0x20

/* RxTx Mapping */
/* Memory Map Position 0x56 - 0x5C */
#define RX_TX_MAP_0                              0x00
#define RX_TX_MAP_1                              0x03
#define RX_TX_MAP_2                              0x05
#define RX_TX_MAP_3                              0x07
#define RX_TX_MAP_4                              0x08
#define RX_TX_MAP_5                              0x09
#define RX_TX_MAP_6                              0x03
#define RX_TX_MAP_7                              0x07
#define RX_TX_MAP_8                              0x08
#define RX_TX_MAP_9                              0x09
#define RX_TX_MAP_10                             0x0A
#define RX_TX_MAP_11                             0x0B
#define RX_TX_MAP_12                             0x0C
#define RX_TX_MAP_FILLER                         0x00

/* Allocation of channels into cycles 0-9 */
/* Memory Map Position 0x5D - 0x6B */
#define PLACEHOLDER_0                            0x05
#define CH_1_CYCLE_0                             0x00
#define CH_2_CYCLE_0                             0x02
#define PLACEHOLDER_1                            0x05
#define CH_1_CYCLE_1                             0x01
#define CH_2_CYCLE_1                             0xFF
#define PLACEHOLDER_2                            0x05
#define CH_1_CYCLE_2                             0x03
#define CH_2_CYCLE_2                             0x05
#define PLACEHOLDER_3                            0x05
#define CH_1_CYCLE_3                             0x04
#define CH_2_CYCLE_3                             0xFF
#define PLACEHOLDER_4                            0x05
#define CH_1_CYCLE_4                             0x06
#define CH_2_CYCLE_4                             0x08
#define PLACEHOLDER_5                            0x05
#define CH_1_CYCLE_5                             0x07
#define CH_2_CYCLE_5                             0xFF
#define PLACEHOLDER_6                            0x05
#define CH_1_CYCLE_6                             0xFF
#define CH_2_CYCLE_6                             0xFF
#define PLACEHOLDER_7                            0x05
#define CH_1_CYCLE_7                             0xFF
#define CH_2_CYCLE_7                             0xFF
#define PLACEHOLDER_8                            0x05
#define CH_1_CYCLE_8                             0xFF
#define CH_2_CYCLE_8                             0xFF
#define PLACEHOLDER_9                            0x05
#define CH_1_CYCLE_9                             0xFF
#define CH_2_CYCLE_9                             0xFF

/* Allocation of channels into cycles 10-19 */
/* Memory Map Position 0x6C - 0x7A */
#define PLACEHOLDER_10                           0x05
#define CH_1_CYCLE_10                            0xFF
#define CH_2_CYCLE_10                            0xFF
#define PLACEHOLDER_11                           0x05
#define CH_1_CYCLE_11                            0xFF
#define CH_2_CYCLE_11                            0xFF
#define PLACEHOLDER_12                           0x05
#define CH_1_CYCLE_12                            0xFF
#define CH_2_CYCLE_12                            0xFF
#define PLACEHOLDER_13                           0x05
#define CH_1_CYCLE_13                            0xFF
#define CH_2_CYCLE_13                            0xFF
#define PLACEHOLDER_14                           0x05
#define CH_1_CYCLE_14                            0xFF
#define CH_2_CYCLE_14                            0xFF
#define PLACEHOLDER_15                           0x05
#define CH_1_CYCLE_15                            0xFF
#define CH_2_CYCLE_15                            0xFF
#define PLACEHOLDER_16                           0x05
#define CH_1_CYCLE_16                            0xFF
#define CH_2_CYCLE_16                            0xFF
#define PLACEHOLDER_17                           0x05
#define CH_1_CYCLE_17                            0xFF
#define CH_2_CYCLE_17                            0xFF
#define PLACEHOLDER_18                           0x05
#define CH_1_CYCLE_18                            0xFF
#define CH_2_CYCLE_18                            0xFF
#define PLACEHOLDER_19                           0x05
#define CH_1_CYCLE_19                            0xFF
#define CH_2_CYCLE_19                            0xFF

/* Allocation of channels into cycles 20 */
/* Memory Map Position 0x7B - 0x7C */
#define PLACEHOLDER_20                           0x05
#define CH_1_CYCLE_20                            0xFF
#define CH_2_CYCLE_20                            0xFF

#endif /* IQS7211E_INIT_H */
