/*
 * Copyright (c) 2023 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

#include <pm_config.h>
#include "zephyr/autoconf.h"
#include "region_defs.h"
#include "utilities.h"

#define IS_ALIGNED_POW2(value, align) (((value) & ((align)-1)) == 0)

/* Making sure the borders between secure and non-secure regions are
 * aligned with the TrustZone SPU/MPC requirements.
 */
#if !(IS_ALIGNED_POW2(PM_TFM_NONSECURE_ADDRESS, CONFIG_NRF_TRUSTZONE_FLASH_REGION_SIZE))
#pragma message \
	"\n\n!!!Partition alignment error!!!" \
	"\nThe non-secure start address in pm_static.yml" \
	" or generated partition.yml is: " \
	M2S(PM_TFM_NONSECURE_ADDRESS) \
	"\nwhich is not aligned with the SPU/MPC HW requirements."				\
	"\nIn nRF53/nRF91 series the flash region need to be aligned with the SPU region size." \
	"\nIn nRF54L15 the flash region need to be aligned with the MPC region size." \
	"\nRefer to the documentation section 'TF-M partition alignment requirements'" \
	"\nfor more information.\n\n"

#error "TF-M non-secure start address is not aligned to SPU/MPC HW requirements"
#endif

#if !(IS_ALIGNED_POW2(PM_SRAM_NONSECURE_ADDRESS, CONFIG_NRF_TRUSTZONE_RAM_REGION_SIZE))
#pragma message \
	"SRAM non-secure address is not aligned to SPU/MPC HW requirements" \
	"\nIn nRF53/nRF91 series the RAM region need to be aligned with the SPU region size." \
	"\nIn nRF54L15 the RAM region need to be aligned with the MPC region size.\n\n"

#error "SRAM non-secure start address is not aligned to SPU/MPC HW requirements"
#endif
