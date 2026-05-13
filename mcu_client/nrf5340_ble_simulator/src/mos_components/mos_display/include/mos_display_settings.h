#ifndef MOS_DISPLAY_SETTINGS_H_
#define MOS_DISPLAY_SETTINGS_H_

#include <stdbool.h>
#include <stdint.h>

/* Persistence for display-related user settings (NVS-backed via Zephyr settings subsystem).
 * Stored under the "mos/display" subtree; relies on settings_load() being invoked at boot.
 * 显示相关用户设置的持久化（基于 Zephyr settings/NVS）。命名空间："mos/display"。 */

/* Persist the raw 1..8 display height value sent from the phone.
 * Returns 0 on success, -EINVAL for out-of-range input, or a negative errno from the
 * settings/flash layer. No-op (returns 0) if the value already matches what's stored. */
int mos_display_settings_save_height(uint8_t height);

/* Copy the loaded height into *out and return true if a valid value has been read
 * from flash. Returns false if no value has been persisted yet, in which case *out
 * is left untouched. */
bool mos_display_settings_get_height(uint8_t *out);

/* Re-scan the "mos/display" subtree from NVS. Idempotent; useful when callers
 * can't guarantee main()'s settings_load() finished before they read the value. */
int mos_display_settings_load(void);

#endif /* MOS_DISPLAY_SETTINGS_H_ */
