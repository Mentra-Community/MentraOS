#ifndef MOS_TOUCH_IQS7211E_PROFILE_H_
#define MOS_TOUCH_IQS7211E_PROFILE_H_

#include <stddef.h>
#include <stdint.h>
#include "IQS7211E_init.h"

typedef struct
{
    uint8_t start_reg;
    const uint8_t *data;
    size_t len;
} mos_touch_iqs7211e_profile_block_t;

size_t mos_touch_iqs7211e_profile_block_count(void);

const mos_touch_iqs7211e_profile_block_t *mos_touch_iqs7211e_profile_block_at(size_t index);

#endif /* MOS_TOUCH_IQS7211E_PROFILE_H_ */
