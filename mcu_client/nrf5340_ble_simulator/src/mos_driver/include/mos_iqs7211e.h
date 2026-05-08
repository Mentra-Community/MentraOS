#ifndef MOS_IQS7211E_H_
#define MOS_IQS7211E_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <zephyr/sys/util.h>

/* IQS7211E fixed 7-bit I2C address. */
#ifndef IQS7211E_I2C_ADDR
#define IQS7211E_I2C_ADDR 0x56
#endif

/* Read-only runtime register map. Each address returns a 16-bit little-endian word. */
#define IQS7211E_REG_PRODUCT_NUMBER                 0x00
#define IQS7211E_REG_MAJOR_VERSION                  0x01
#define IQS7211E_REG_MINOR_VERSION                  0x02
#define IQS7211E_PRODUCT_NUMBER_VALUE               0x0458u
#define IQS7211E_REG_REL_X                          0x0A
#define IQS7211E_REG_REL_Y                          0x0B
#define IQS7211E_REG_GESTURE_X                      0x0C
#define IQS7211E_REG_GESTURE_Y                      0x0D
#define IQS7211E_REG_GESTURES                       0x0E
#define IQS7211E_REG_INFO_FLAGS                     0x0F
#define IQS7211E_REG_FINGER1_X                      0x10
#define IQS7211E_REG_FINGER1_Y                      0x11
#define IQS7211E_REG_FINGER1_TOUCH_STRENGTH         0x12
#define IQS7211E_REG_FINGER1_AREA                   0x13
#define IQS7211E_REG_FINGER2_X                      0x14
#define IQS7211E_REG_FINGER2_Y                      0x15
#define IQS7211E_REG_FINGER2_TOUCH_STRENGTH         0x16
#define IQS7211E_REG_FINGER2_AREA                   0x17
#define IQS7211E_REG_TOUCH_STATUS0                  0x18
#define IQS7211E_REG_TOUCH_STATUS1                  0x19
#define IQS7211E_REG_TOUCH_STATUS2                  0x1A

/* Control/config registers used by this driver and the touch application layer. */
#define IQS7211E_REG_SYSTEM_CONTROL                 0x33
#define IQS7211E_REG_CONFIG_SETTINGS                0x34
#define IQS7211E_REG_GESTURE_ENABLE                 0x4B
#define IQS7211E_REG_TAP_TIME                       0x4C
#define IQS7211E_REG_AIR_TIME                       0x4D
#define IQS7211E_REG_TAP_DISTANCE                   0x4E
#define IQS7211E_REG_HOLD_TIME                      0x4F
#define IQS7211E_REG_SWIPE_TIME                     0x50
#define IQS7211E_REG_SWIPE_INITIAL_X_DISTANCE       0x51
#define IQS7211E_REG_SWIPE_INITIAL_Y_DISTANCE       0x52
#define IQS7211E_REG_SWIPE_CONSECUTIVE_X_DISTANCE   0x53
#define IQS7211E_REG_SWIPE_CONSECUTIVE_Y_DISTANCE   0x54
#define IQS7211E_REG_SWIPE_ANGLE_PALM_THRESHOLD     0x55

/* Communication request / command address from the IQS7211E I2C interface. */
#define IQS7211E_CMD_COMM_REQUEST                   0xFF

/* Gestures register bits (0x0E) and Gesture Enable bits (0x4B). */
#define IQS7211E_GESTURE_SINGLE_TAP                 BIT(0)
#define IQS7211E_GESTURE_DOUBLE_TAP                 BIT(1)
#define IQS7211E_GESTURE_TRIPLE_TAP                 BIT(2)
#define IQS7211E_GESTURE_PRESS_AND_HOLD             BIT(3)
#define IQS7211E_GESTURE_PALM                       BIT(4)
#define IQS7211E_GESTURE_SWIPE_X_POSITIVE           BIT(8) // x+
#define IQS7211E_GESTURE_SWIPE_X_NEGATIVE           BIT(9) // x-
#define IQS7211E_GESTURE_SWIPE_Y_POSITIVE           BIT(10)// y+
#define IQS7211E_GESTURE_SWIPE_Y_NEGATIVE           BIT(11)// y-
#define IQS7211E_GESTURE_SWIPE_HOLD_X_POSITIVE      BIT(12)// x+ hold
#define IQS7211E_GESTURE_SWIPE_HOLD_X_NEGATIVE      BIT(13)// x- hold
#define IQS7211E_GESTURE_SWIPE_HOLD_Y_POSITIVE      BIT(14)// y+ hold
#define IQS7211E_GESTURE_SWIPE_HOLD_Y_NEGATIVE      BIT(15)// y- hold

/* Info Flags register bits (0x0F). */
#define IQS7211E_INFO_CHARGING_MODE_MASK            0x0007u
#define IQS7211E_INFO_ATI_ERROR                     BIT(3)
#define IQS7211E_INFO_REATI_OCCURRED                BIT(4)
#define IQS7211E_INFO_ALP_ATI_ERROR                 BIT(5)
#define IQS7211E_INFO_ALP_REATI_OCCURRED            BIT(6)
#define IQS7211E_INFO_SHOW_RESET                    BIT(7)
#define IQS7211E_INFO_NUM_FINGERS_MASK              0x0300u
#define IQS7211E_INFO_TP_MOVEMENT                   BIT(10)
#define IQS7211E_INFO_TOO_MANY_FINGERS              BIT(12)
#define IQS7211E_INFO_ALP_OUTPUT                    BIT(14)

/* System Control register bits (0x33). */
#define IQS7211E_SYSTEM_MODE_SELECT_MASK            0x0007u
#define IQS7211E_SYSTEM_TP_RESEED                   BIT(3)
#define IQS7211E_SYSTEM_ALP_RESEED                  BIT(4)
#define IQS7211E_SYSTEM_TP_REATI                    BIT(5)
#define IQS7211E_SYSTEM_ALP_REATI                   BIT(6)
#define IQS7211E_SYSTEM_ACK_RESET                   BIT(7)
#define IQS7211E_SYSTEM_SW_RESET                    BIT(9)
#define IQS7211E_SYSTEM_SUSPEND                     BIT(11)

/* Config Settings register bits (0x34). */
#define IQS7211E_CONFIG_TP_REATI_EN                 BIT(2)
#define IQS7211E_CONFIG_ALP_REATI_EN                BIT(3)
#define IQS7211E_CONFIG_COMMS_REQUEST_EN            BIT(4)
#define IQS7211E_CONFIG_WDT                         BIT(5)
#define IQS7211E_CONFIG_COMMS_END_CMD               BIT(6)
#define IQS7211E_CONFIG_MANUAL_CONTROL              BIT(7)
#define IQS7211E_CONFIG_EVENT_MODE                  BIT(8)
#define IQS7211E_CONFIG_GESTURE_EVENT               BIT(9)
#define IQS7211E_CONFIG_TP_EVENT                    BIT(10)
#define IQS7211E_CONFIG_REATI_EVENT                 BIT(11)
#define IQS7211E_CONFIG_ALP_EVENT                   BIT(13)
#define IQS7211E_CONFIG_TP_TOUCH_EVENT              BIT(14)

typedef enum
{
    MOS_IQS7211E_SLIDE_NONE = 0,
    MOS_IQS7211E_SLIDE_X_INCREASE,  // x+
    MOS_IQS7211E_SLIDE_X_DECREASE,  // x-
    MOS_IQS7211E_SLIDE_Y_INCREASE,  // y+
    MOS_IQS7211E_SLIDE_Y_DECREASE,  // y-
} mos_iqs7211e_slide_direction_t;

typedef void (*mos_iqs7211e_runtime_callback_t)(uint16_t gestures, uint16_t info_flags, uint16_t finger1_x,
                                                uint16_t finger1_y, uint16_t rel_x, uint16_t rel_y, void *user_data);

int mos_iqs7211e_init(void);

int mos_iqs7211e_enable_rdy_interrupt(void);

int mos_iqs7211e_prepare_sleep_wakeup_mode(void);

int mos_iqs7211e_configure_wakeup(void);

int mos_iqs7211e_register_runtime_callback(mos_iqs7211e_runtime_callback_t callback, void *user_data);

int mos_iqs7211e_write_reg16(uint8_t reg, uint16_t value);

int mos_iqs7211e_read_reg16(uint8_t reg, uint16_t *value);

int mos_iqs7211e_write_block8(uint8_t start_reg, const uint8_t *data, size_t len);

int mos_iqs7211e_update_reg16(uint8_t reg, uint16_t mask, uint16_t value);

int mos_iqs7211e_read_version_details(uint16_t *out_words, size_t out_words_count);

int mos_iqs7211e_read_event_states(uint16_t *info_flags, uint16_t *gestures);

int mos_iqs7211e_read_events(uint16_t *gestures);

int mos_iqs7211e_is_touch_active(bool *active);

int mos_iqs7211e_get_last_status(uint16_t *gestures, uint16_t *info_flags, uint16_t *touch_status0);

void mos_iqs7211e_clear_runtime_cache(void);

int mos_iqs7211e_refresh_runtime_cache(void);

int mos_iqs7211e_get_last_runtime_data(uint16_t *gestures, uint16_t *info_flags, uint16_t *finger1_x,
                                       uint16_t *finger1_y, uint16_t *rel_x, uint16_t *rel_y);

#endif /* MOS_IQS7211E_H_ */
