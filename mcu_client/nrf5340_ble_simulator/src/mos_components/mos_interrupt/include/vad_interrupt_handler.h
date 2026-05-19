#ifndef _VAD_INTERRUPT_HANDLER_H_
#define _VAD_INTERRUPT_HANDLER_H_

#include <stdbool.h>
#include <stdint.h>

/**
 * @brief Initialize VAD interrupt handling module.
 *
 * Registers VAD falling-edge and timeout callbacks, initializes internal timer,
 * and performs one-time setup of the optional voice-detect GPIO.
 *
 * @return 0 on success.
 * @return Negative error code when callback registration fails.
 */
int vad_interrupt_handler_init(void);

/**
 * @brief Send a software-generated VAD falling-edge event.
 *
 * Enqueues a synthetic event into the shared interrupt event queue. Useful for
 * testing and controlled trigger flows.
 *
 * @return 0 on success.
 * @return Negative error code when event enqueue fails.
 */
int vad_interrupt_handler_send_event(void);

/**
 * @brief Re-enable GX8002 VAD interrupt after one trigger is handled.
 *
 * @return 0 on success.
 * @return Negative error code if re-enable operation fails.
 */
int vad_interrupt_handler_re_enable(void);

/**
 * @brief Query whether GX8002 I2S reception is currently active.
 *
 * @return true if I2S reception is active.
 * @return false if I2S reception is inactive.
 */
bool vad_interrupt_handler_is_i2s_active(void);

/**
 * @brief Apply the shared MicState-OFF local shutdown sequence.
 *
 * Disables VAD-driven capture, disables the VAD IRQ, stops the nRF I2S slave
 * if active, updates handler state, and sends the GX8002 I2C disable command.
 *
 * @return 0 on success.
 * @return -EALREADY when the local pipeline was already stopped.
 * @return Other negative error code from VAD IRQ disable or nRF I2S stop.
 */
int vad_interrupt_handler_apply_mic_off(void);

/**
 * @brief Notify handler that I2S reception has stopped.
 *
 * Resets internal I2S-active state and timeout-related state.
 *
 * @return None.
 */
void vad_interrupt_handler_notify_i2s_stopped(void);

/**
 * @brief Enable or disable VAD-driven mic capture logic.
 *
 * When disabled, pending timeout is cancelled and capture-related timeout state
 * is cleared.
 *
 * @param enabled true to enable VAD-driven capture; false to disable.
 * @return None.
 */
void vad_interrupt_handler_set_enabled(bool enabled);

/**
 * @brief Query whether VAD-driven mic capture is enabled.
 *
 * @return true if enabled.
 * @return false if disabled.
 */
bool vad_interrupt_handler_is_enabled(void);

/**
 * @brief Force VAD voice-detect GPIO to low level.
 *
 * Intended for validation and test hooks when voice-detect GPIO is available.
 *
 * @return 0 on success.
 * @return -ENODEV if voice-detect GPIO is unavailable or not ready.
 * @return Other negative error code from GPIO configuration or set operation.
 */
int vad_voice_detect_set_low(void);

/**
 * @brief Restore VAD voice-detect GPIO to default high state.
 *
 * Configures the pin as input with pull-up to represent the idle high level.
 *
 * @return 0 on success.
 * @return -ENODEV if voice-detect GPIO is unavailable or not ready.
 * @return Other negative error code from GPIO configuration operation.
 */
int vad_voice_detect_set_high(void);

/**
 * @brief Get the last VAD trigger tick.
 *
 * This timestamp is used as a timing anchor for measuring latency from VAD
 * trigger to I2S/BLE pipeline milestones.
 *
 * @return Last trigger tick in uptime ticks/ms domain used by event source.
 * @return 0 when no active trigger timestamp is available.
 */
int64_t vad_get_trigger_tick(void);

#endif /* _VAD_INTERRUPT_HANDLER_H_ */
