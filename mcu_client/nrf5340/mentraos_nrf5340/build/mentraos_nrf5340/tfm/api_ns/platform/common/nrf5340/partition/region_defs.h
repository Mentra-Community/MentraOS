/*
 * Copyright (c) 2017-2022 Arm Limited. All rights reserved.
 * Copyright (c) 2020 Nordic Semiconductor ASA. All rights reserved.
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

#ifndef __REGION_DEFS_H__
#define __REGION_DEFS_H__

#include "flash_layout.h"

#define BL2_HEAP_SIZE           (0x00001000)
#define BL2_MSP_STACK_SIZE      (0x00001800)

#ifdef ENABLE_HEAP
    #define S_HEAP_SIZE             (0x0000200)
#endif

#define S_MSP_STACK_SIZE        (0x00000800)
#define S_PSP_STACK_SIZE        (0x00000800)

#define NS_HEAP_SIZE            (0x00001000)
#define NS_STACK_SIZE           (0x000001E0)

/* Size of nRF SPU (Nordic IDAU) regions */
#define SPU_FLASH_REGION_SIZE   (0x00004000)
#define SPU_SRAM_REGION_SIZE    (0x00002000)

/*
 * SPU flash region granularity is 16 KB on nRF5340. Alignment
 * of partitions is defined in accordance with this constraint.
 */
#ifdef NRF_NS_SECONDARY
#ifndef LINK_TO_SECONDARY_PARTITION
#define S_IMAGE_PRIMARY_PARTITION_OFFSET   (FLASH_AREA_0_OFFSET)
#define S_IMAGE_SECONDARY_PARTITION_OFFSET (FLASH_AREA_2_OFFSET)
#else
#define S_IMAGE_PRIMARY_PARTITION_OFFSET   (FLASH_AREA_2_OFFSET)
#define S_IMAGE_SECONDARY_PARTITION_OFFSET (FLASH_AREA_0_OFFSET)
#endif /* !LINK_TO_SECONDARY_PARTITION */
#else
#define S_IMAGE_PRIMARY_PARTITION_OFFSET (0x0)
#endif /* NRF_NS_SECONDARY */

#ifndef LINK_TO_SECONDARY_PARTITION
#define NS_IMAGE_PRIMARY_PARTITION_OFFSET (FLASH_AREA_0_OFFSET \
                                           + FLASH_S_PARTITION_SIZE)
#else
#define NS_IMAGE_PRIMARY_PARTITION_OFFSET (FLASH_AREA_2_OFFSET \
                                           + FLASH_S_PARTITION_SIZE)
#endif /* !LINK_TO_SECONDARY_PARTITION */

/* Boot partition structure if MCUBoot is used:
 * 0x0_0000 Bootloader header
 * 0x0_0400 Image area
 * 0x0_FC00 Trailer
 */
/* IMAGE_CODE_SIZE is the space available for the software binary image.
 * It is less than the FLASH_S_PARTITION_SIZE + FLASH_NS_PARTITION_SIZE
 * because we reserve space for the image header and trailer introduced
 * by the bootloader.
 */

#if (!defined(MCUBOOT_IMAGE_NUMBER) || (MCUBOOT_IMAGE_NUMBER == 1)) && \
    (NS_IMAGE_PRIMARY_PARTITION_OFFSET > S_IMAGE_PRIMARY_PARTITION_OFFSET)
/* If secure image and nonsecure image are concatenated, and nonsecure image
 * locates at the higher memory range, then the secure image does not need
 * the trailer area.
 */
#define IMAGE_S_CODE_SIZE \
            (FLASH_S_PARTITION_SIZE - BL2_HEADER_SIZE)
#else
#define IMAGE_S_CODE_SIZE \
            (FLASH_S_PARTITION_SIZE - BL2_HEADER_SIZE - BL2_TRAILER_SIZE)
#endif

#define IMAGE_NS_CODE_SIZE \
            (FLASH_NS_PARTITION_SIZE - BL2_HEADER_SIZE - BL2_TRAILER_SIZE)

/* Alias definitions for secure and non-secure areas*/
#define S_ROM_ALIAS(x)  (S_ROM_ALIAS_BASE + (x))
#define NS_ROM_ALIAS(x) (NS_ROM_ALIAS_BASE + (x))

#define S_RAM_ALIAS(x)  (S_RAM_ALIAS_BASE + (x))
#define NS_RAM_ALIAS(x) (NS_RAM_ALIAS_BASE + (x))

/* Secure regions */
#define S_IMAGE_PRIMARY_AREA_OFFSET \
                        (S_IMAGE_PRIMARY_PARTITION_OFFSET + BL2_HEADER_SIZE)
#define S_CODE_START    (S_ROM_ALIAS(S_IMAGE_PRIMARY_AREA_OFFSET))
#define S_CODE_SIZE     (IMAGE_S_CODE_SIZE)
#define S_CODE_LIMIT    (S_CODE_START + S_CODE_SIZE - 1)

#define S_DATA_START    (S_RAM_ALIAS(0x0))
#define S_DATA_SIZE     (TOTAL_RAM_SIZE / 2)
#define S_DATA_LIMIT    (S_DATA_START + S_DATA_SIZE - 1)

#define S_CODE_VECTOR_TABLE_SIZE (0x154)

#if defined(NULL_POINTER_EXCEPTION_DETECTION) && S_CODE_START == 0
/* If this image is placed at the beginning of flash make sure we
 * don't put any code in the first 256 bytes of flash as that area
 * is used for null-pointer dereference detection.
 */
#define TFM_LINKER_CODE_START_RESERVED (256)
#if S_CODE_VECTOR_TABLE_SIZE < TFM_LINKER_CODE_START_RESERVED
#error "The interrupt table is too short too for null pointer detection"
#endif
#endif

/* The veneers needs to be placed at the end of the secure image.
 * This is because the NCS sub-region is defined as starting at the highest
 * address of an SPU region and going downwards.
 */
#define TFM_LINKER_VENEERS_LOCATION_END
/* The CMSE veneers shall be placed in an NSC region
 * which will be placed in a secure SPU region with the given alignment.
 */
#define TFM_LINKER_VENEERS_SIZE     (0x400)
/* The Nordic SPU has different alignment requirements than the ARM SAU, so
 * these override the default start and end alignments. */
#define TFM_LINKER_VENEERS_START \
            (ALIGN(SPU_FLASH_REGION_SIZE) - TFM_LINKER_VENEERS_SIZE + \
                (. > (ALIGN(SPU_FLASH_REGION_SIZE) - TFM_LINKER_VENEERS_SIZE) \
                    ? SPU_FLASH_REGION_SIZE : 0))

#define TFM_LINKER_VENEERS_END ALIGN(SPU_FLASH_REGION_SIZE)

/* Non-secure regions */
#define NS_IMAGE_PRIMARY_AREA_OFFSET \
                        (NS_IMAGE_PRIMARY_PARTITION_OFFSET + BL2_HEADER_SIZE)
#define NS_CODE_START   (NS_ROM_ALIAS(NS_IMAGE_PRIMARY_AREA_OFFSET))
#define NS_CODE_SIZE    (IMAGE_NS_CODE_SIZE)
#define NS_CODE_LIMIT   (NS_CODE_START + NS_CODE_SIZE - 1)

#define NS_DATA_START   (NS_RAM_ALIAS(S_DATA_SIZE))
#ifdef PSA_API_TEST_IPC
/* Last SRAM region must be kept secure for PSA FF tests */
#define NS_DATA_SIZE    (TOTAL_RAM_SIZE - S_DATA_SIZE - SPU_SRAM_REGION_SIZE)
#else
#define NS_DATA_SIZE    (TOTAL_RAM_SIZE - S_DATA_SIZE)
#endif
#define NS_DATA_LIMIT   (NS_DATA_START + NS_DATA_SIZE - 1)

/* NS partition information is used for SPU configuration */
#define NS_PARTITION_START \
            (NS_ROM_ALIAS(NS_IMAGE_PRIMARY_PARTITION_OFFSET))
#define NS_PARTITION_SIZE (FLASH_NS_PARTITION_SIZE)

/* Secondary partition for new images in case of firmware upgrade */
#define SECONDARY_PARTITION_START \
            (NS_ROM_ALIAS(S_IMAGE_SECONDARY_PARTITION_OFFSET))
#define SECONDARY_PARTITION_SIZE (FLASH_S_PARTITION_SIZE + \
                                  FLASH_NS_PARTITION_SIZE)

/* Non-secure storage region */
#ifdef NRF_NS_STORAGE
#define NRF_NS_STORAGE_PARTITION_START \
            (NS_ROM_ALIAS(NRF_FLASH_NS_STORAGE_AREA_OFFSET))
#define NRF_NS_STORAGE_PARTITION_SIZE (NRF_FLASH_NS_STORAGE_AREA_SIZE)
#endif /* NRF_NS_STORAGE */

#ifdef BL2
/* Bootloader regions */
#define BL2_CODE_START    (S_ROM_ALIAS(FLASH_AREA_BL2_OFFSET))
#define BL2_CODE_SIZE     (FLASH_AREA_BL2_SIZE)
#define BL2_CODE_LIMIT    (BL2_CODE_START + BL2_CODE_SIZE - 1)

#define BL2_DATA_START    (S_RAM_ALIAS(0x0))
#define BL2_DATA_SIZE     (TOTAL_RAM_SIZE)
#define BL2_DATA_LIMIT    (BL2_DATA_START + BL2_DATA_SIZE - 1)
#endif /* BL2 */

/* Shared data area between bootloader and runtime firmware.
 * Shared data area is allocated at the beginning of the RAM, it is overlapping
 * with TF-M Secure code's MSP stack
 */
#define BOOT_TFM_SHARED_DATA_BASE S_RAM_ALIAS_BASE
#define BOOT_TFM_SHARED_DATA_SIZE (0x400)
#define BOOT_TFM_SHARED_DATA_LIMIT (BOOT_TFM_SHARED_DATA_BASE + \
                                    BOOT_TFM_SHARED_DATA_SIZE - 1)

/* Regions used by psa-arch-tests to keep state */
#define PSA_TEST_SCRATCH_AREA_SIZE (0x400)

#ifdef PSA_API_TEST_IPC
/* Firmware Framework test suites */
#define FF_TEST_PARTITION_SIZE 0x100
#define PSA_TEST_SCRATCH_AREA_BASE (NS_DATA_LIMIT + 1 - \
                                    PSA_TEST_SCRATCH_AREA_SIZE - \
                                    FF_TEST_PARTITION_SIZE)

/* The psa-arch-tests implementation requires that the test partitions are
 * placed in this specific order:
 * TEST_NSPE_MMIO < TEST_SERVER < TEST_DRIVER
 *
 * TEST_NSPE_MMIO region must be in the NSPE, while TEST_SERVER and TEST_DRIVER
 * must be in SPE.
 *
 * The TEST_NSPE_MMIO region is defined in the psa-arch-tests implementation,
 * and it should be placed at the end of the NSPE area, after
 * PSA_TEST_SCRATCH_AREA.
 */
#define FF_TEST_SERVER_PARTITION_MMIO_START  (NS_DATA_LIMIT + 1)
#define FF_TEST_SERVER_PARTITION_MMIO_END    (FF_TEST_SERVER_PARTITION_MMIO_START + \
                                              FF_TEST_PARTITION_SIZE - 1)
#define FF_TEST_DRIVER_PARTITION_MMIO_START  (FF_TEST_SERVER_PARTITION_MMIO_END + 1)
#define FF_TEST_DRIVER_PARTITION_MMIO_END    (FF_TEST_DRIVER_PARTITION_MMIO_START + \
                                              FF_TEST_PARTITION_SIZE - 1)
#else
/* Development APIs test suites */
#define PSA_TEST_SCRATCH_AREA_BASE (NS_DATA_LIMIT + 1 - \
                                    PSA_TEST_SCRATCH_AREA_SIZE)
#endif /* PSA_API_TEST_IPC */

#endif /* __REGION_DEFS_H__ */
