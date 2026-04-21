#ifndef MOS_IQS7211A_H_
#define MOS_IQS7211A_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* IQS I2C address (7-bit). Adjust if your order code differs. */
#ifndef IQS7211A_I2C_ADDR
#define IQS7211A_I2C_ADDR 0x56
#endif

/* Runtime register map
 * NOTE: current bring-up target is IQS7211A demo board.
 * IQS7211A runtime block:
 *   0x10 INFO_FLAGS
 *   0x11 GESTURES
 *   0x12 REL_X
 *   0x13 REL_Y
 *   0x14 FINGER1_X
 *   0x15 FINGER1_Y
 */
#define IQS7211A_REG_INFO_FLAGS 0x10
#define IQS7211A_REG_GESTURES 0x11
#define IQS7211A_REG_REL_X 0x12
#define IQS7211A_REG_REL_Y 0x13
#define IQS7211A_REG_FINGER1_X 0x14
#define IQS7211A_REG_FINGER1_Y 0x15

/* Common control/config registers used during init (7211A-compatible). */
#define IQS7211A_REG_SYSTEM_CONTROL 0x50
#define IQS7211A_REG_CONFIG_SETTINGS 0x51

/* Communication end command (used by IQS ProxFusion over I2C). */
#define IQS7211A_CMD_END_COMM 0xFF

/** Min |dX| or |dY| (counts) between consecutive FINGER1 samples to report a slide axis (noise filter). */
#ifndef IQS7211A_SLIDE_MIN_DELTA
#define IQS7211A_SLIDE_MIN_DELTA 2
#endif

/** Inferred slide from consecutive FINGER1_X/Y in RDY cache (chip coordinate sense; map to UX in app). */
typedef enum
{
    MOS_IQS7211A_SLIDE_NONE = 0,
    MOS_IQS7211A_SLIDE_X_INCREASE,
    MOS_IQS7211A_SLIDE_X_DECREASE,
    MOS_IQS7211A_SLIDE_Y_INCREASE,
    MOS_IQS7211A_SLIDE_Y_DECREASE,
} mos_iqs7211a_slide_direction_t;

typedef void (*mos_iqs7211a_runtime_callback_t)(uint16_t gestures, uint16_t info_flags, uint16_t finger1_x,
                                                uint16_t finger1_y, uint16_t rel_x, uint16_t rel_y, void *user_data);

/**
 * @brief Register one callback for raw runtime frames refreshed by RDY.
 *
 * The callback runs in the driver's RDY work context after cache refresh.
 * Keep the callback short and non-blocking. Pass @c NULL to unregister.
 */
int mos_iqs7211a_register_runtime_callback(mos_iqs7211a_runtime_callback_t callback, void *user_data);

/**
 * @brief Write a 16-bit word to an 8-bit memory-map register.
 *
 * Exposed for application-layer configuration (e.g. gesture tuning) so policy does not live in the driver.
 */
int mos_iqs7211a_write_reg16(uint8_t reg, uint16_t value);

/**
 * @brief Write a contiguous block to the 8-bit memory map starting at @p start_reg.
 *
 * Exposed for application-layer configuration blocks (e.g. 0x60/0x70/0x80/0x90 profiles).
 */
int mos_iqs7211a_write_block8(uint8_t start_reg, const uint8_t *data, size_t len);

/**
 * @brief Update masked bits of a 16-bit register while preserving other bits.
 */
int mos_iqs7211a_update_reg16(uint8_t reg, uint16_t mask, uint16_t value);

/**
 * @brief Full driver init: I2C + chip registers (7211A-class sequence) + RDY GPIO interrupt and work queue.
 *
 * Call once from application (e.g. after @c opt3006_initialize() on the shared bus). Idempotent:
 * chip sequence runs only on first success; RDY is re-configured on each call (safe for re-arm).
 */
int mos_iqs7211a_init(void);

/**
 * @brief Read raw event states.
 * @param prox_event_states Raw register value for proximity event states (0x12).
 * @param touch_event_states Raw register value for touch event states (0x13).
 * @return 0 on success, negative on error.
 */
int mos_iqs7211a_read_event_states(uint16_t *prox_event_states, uint16_t *touch_event_states);

/**
 * @brief Read raw Events register (0x11) to clear event flags (event mode requirement).
 */
int mos_iqs7211a_read_events(uint16_t *events);

/**
 * @brief Convenience helper: derive "any touch active" from touch event states.
 */
int mos_iqs7211a_is_touch_active(bool *active);

/**
 * @brief Read IQS ProxFusion version details (datasheet registers 0x00..0x09).
 *
 * Returns 16-bit words (little-endian). With RDY in devicetree, data is filled from the RDY window cache.
 *
 * @param out_words Caller-provided array to receive words.
 * @param out_words_count How many words to read (max 10 recommended).
 * @return 0 on success, negative error code otherwise.
 */
int mos_iqs7211a_read_version_details(uint16_t *out_words, size_t out_words_count);

/**
 * @brief Re-run @c mos_iqs7211a_init() to re-arm RDY (e.g. shell recovery).
 *
 * Property `iqs7211a_rdy-gpios` under `zephyr,user` (e.g. P1.14, GPIO_ACTIVE_LOW per datasheet).
 * Falling edge: RDY asserts low to open the I2C window.
 */
int mos_iqs7211a_enable_rdy_interrupt(void);

/**
 * @brief Get latest cached 0x11..0x13 values (from RDY ISR/work).
 * @return 0 if cache valid, negative otherwise.
 */
int mos_iqs7211a_get_last_status(uint16_t *events, uint16_t *prox, uint16_t *touch);

/**
 * @brief Get latest cached runtime data (INFO @ 0x10 .. FINGER1_Y @ 0x15 from RDY block read).
 * @param rel_x @c NULL or receives 0x12 REL_X (often signed step; interpret per datasheet).
 * @param rel_y @c NULL or receives 0x13 REL_Y.
 * @return 0 if cache valid, negative otherwise.
 */
int mos_iqs7211a_get_last_runtime_data(uint16_t *gestures, uint16_t *info_flags, uint16_t *finger1_x,
                                       uint16_t *finger1_y, uint16_t *rel_x, uint16_t *rel_y);

/**
 * @brief Get RDY interrupt/debug counters.
 * @return 0 on success, negative error otherwise.
 */
int mos_iqs7211a_get_debug_counters(uint32_t *isr_count, uint32_t *work_count, uint32_t *read_ok_count,
                                    uint32_t *read_fail_count, uint32_t *filtered_count);

#endif /* MOS_IQS7211A_H_ */
