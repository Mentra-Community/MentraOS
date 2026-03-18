/*
 * Copyright (c) 2022 Nordic Semiconductor ASA. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <string.h>
#include "tfm_plat_test.h"
#include "pal_plat_test.h"
#include <stdint.h>
#include <stdbool.h>
#include <helpers/nrfx_reset_reason.h>
#include <region_defs.h>

uint32_t pal_nvmem_get_addr(void)
{
#ifdef NRF_TRUSTZONE_NONSECURE
    static bool psa_scratch_initialized = false;

    if (!psa_scratch_initialized) {
        uint32_t reset_reason = nrfx_reset_reason_get();
        nrfx_reset_reason_clear(reset_reason);

        int is_pinreset = reset_reason & NRFX_RESET_REASON_RESETPIN_MASK;
        if ((reset_reason == 0) || is_pinreset){
            /* PSA API tests expect this area to be initialized to all 0xFFs
             * after a power-on or pin reset.
             */
            memset((void*)PSA_TEST_SCRATCH_AREA_BASE, 0xFF, PSA_TEST_SCRATCH_AREA_SIZE);
        }
        psa_scratch_initialized = true;
    }
#endif /* NRF_TRUSTZONE_NONSECURE */
    return (uint32_t)PSA_TEST_SCRATCH_AREA_BASE;
}
