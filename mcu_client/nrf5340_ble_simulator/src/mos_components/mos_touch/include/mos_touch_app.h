#ifndef MOS_TOUCH_APP_H_
#define MOS_TOUCH_APP_H_

#include <stdbool.h>
#include <stdint.h>

#include "mos_iqs7211e.h"

int mos_touch_app_init(void);

int mos_touch_app_apply_profile(void);

void mos_touch_app_set_debug_frame_logging(bool enabled);

#endif  // MOS_TOUCH_APP_H_
