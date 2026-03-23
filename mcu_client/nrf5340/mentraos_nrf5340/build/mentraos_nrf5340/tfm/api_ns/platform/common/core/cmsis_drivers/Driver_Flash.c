/*
 * Copyright (c) 2013-2018 Arm Limited. All rights reserved.
 * Copyright (c) 2020 Nordic Semiconductor ASA. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the License); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an AS IS BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <Driver_Flash.h>
#include <RTE_Device.h>
#include <flash_layout.h>
#include <string.h>

#include <nrf.h>

#ifdef __NRF_TFM__
#include <zephyr/autoconf.h>
#endif

#if defined(NRF_NVMC_S)
#include <nrfx_nvmc.h>
#elif defined(NRF_RRAMC_S)
#include <nrfx_rramc.h>

#if CONFIG_NRF_RRAM_WRITE_BUFFER_SIZE > 0
#define WRITE_BUFFER_SIZE CONFIG_NRF_RRAM_WRITE_BUFFER_SIZE
#else
#define WRITE_BUFFER_SIZE 0
#endif

#else
#error "Unrecognized platform"
#endif

#ifndef ARG_UNUSED
#define ARG_UNUSED(arg)  (void)arg
#endif

#if RTE_FLASH0

/*
 * The data width for this driver is 4 bytes and a
 * ARM_FLASH_CAPABILITIES.data_width field value of 2 means 4 bytes
 * (see documentation for struct ARM_FLASH_CAPABILITIES).
 */
#define ARM_FLASH_CAPABILITIES_DATA_WIDTH 2
#define ARM_FLASH_CAPABILITIES_DATA_WIDTH_SIZE 4

static const ARM_FLASH_CAPABILITIES DriverCapabilities = {
    .event_ready = 0,
    .data_width  = ARM_FLASH_CAPABILITIES_DATA_WIDTH,
    .erase_chip  = 0
};

static ARM_FLASH_INFO FlashInfo = {
    .sector_info  = NULL, /* Uniform sector layout */
    .sector_count = FLASH_TOTAL_SIZE / FLASH_AREA_IMAGE_SECTOR_SIZE,
    .sector_size  = FLASH_AREA_IMAGE_SECTOR_SIZE,
	/* page_size denotes the optimal programming page size in bytes
	 * for fast programming, but is currently unused by TF-M. */
    .page_size    = sizeof(uint32_t),
	/* Note that program_unit must match TFM_HAL_ITS_PROGRAM_UNIT */
    .program_unit = sizeof(uint32_t),
    .erased_value = 0xFF
};

static bool is_range_valid(uint32_t addr, uint32_t cnt)
{
    uint32_t start_offset = (addr - FLASH_BASE_ADDRESS);

    if (start_offset > FLASH_TOTAL_SIZE) {
        return false;
    }

    if (cnt > (FLASH_TOTAL_SIZE - start_offset)) {
        return false;
    }

    return true;
}

static ARM_FLASH_CAPABILITIES ARM_Flash_GetCapabilities(void)
{
    return DriverCapabilities;
}

static int32_t ARM_Flash_Initialize(ARM_Flash_SignalEvent_t cb_event)
{
    ARG_UNUSED(cb_event);


#ifdef RRAMC_PRESENT
	nrfx_rramc_config_t config = NRFX_RRAMC_DEFAULT_CONFIG(WRITE_BUFFER_SIZE);

	config.mode_write = true;

#if CONFIG_NRF_RRAM_READYNEXT_TIMEOUT_VALUE > 0
	config.preload_timeout_enable = true;
	config.preload_timeout = CONFIG_NRF_RRAM_READYNEXT_TIMEOUT_VALUE;
#else
	config.preload_timeout_enable = false;
	config.preload_timeout = 0;
#endif

	/* Don't use an event handler until it's understood whether we
	 * want it or not
	 */
	nrfx_rramc_evt_handler_t handler = NULL;

	nrfx_err_t err = nrfx_rramc_init(&config, handler);

	if(err != NRFX_SUCCESS && err != NRFX_ERROR_ALREADY) {
		return err;
	}
#endif /* RRAMC_PRESENT */
    return ARM_DRIVER_OK;
}

// The unitialize function is called by the BL2 bootloader when we build
// the TF-M PSA arch tests in upstream Zephyr, so we need to keep it
// even though it doesn't do anything.
static int32_t ARM_Flash_Unitialize(void)
{
    return ARM_DRIVER_OK;
}

static int32_t ARM_Flash_ReadData(uint32_t addr, void *data, uint32_t cnt)
{
    /* Conversion between data items and bytes */
    uint32_t bytes = cnt * ARM_FLASH_CAPABILITIES_DATA_WIDTH_SIZE;

    if (!is_range_valid(addr, bytes)) {
        return ARM_DRIVER_ERROR_PARAMETER;
    }

    memcpy(data, (const void *)addr, bytes);

    return cnt;
}

static int32_t ARM_Flash_ProgramData(uint32_t addr, const void *data,
                                     uint32_t cnt)
{
    /* Conversion between data items and bytes */
    uint32_t bytes = cnt * ARM_FLASH_CAPABILITIES_DATA_WIDTH_SIZE;

    /* Only aligned writes of full 32-bit words are allowed. */
    if (addr % sizeof(uint32_t)) {
        return ARM_DRIVER_ERROR_PARAMETER;
    }

    if (!is_range_valid(addr, bytes)) {
        return ARM_DRIVER_ERROR_PARAMETER;
    }

#ifdef NRF_NVMC_S
    nrfx_nvmc_words_write(addr, data, cnt);
#else
	nrf_rramc_config_t rramc_config;
	nrf_rramc_config_get(NRF_RRAMC, &rramc_config);
	const nrf_rramc_config_t orig_rramc_config = rramc_config;
	rramc_config.write_buff_size = 0;
	nrf_rramc_config_set(NRF_RRAMC, &rramc_config);

	nrfx_rramc_words_write(addr, data, cnt);

	nrf_rramc_config_set(NRF_RRAMC, &orig_rramc_config);
#endif

    return cnt;
}

static int32_t ARM_Flash_EraseSector(uint32_t addr)
{
#ifdef NRF_NVMC_S
    nrfx_err_t err_code = nrfx_nvmc_page_erase(addr);

    if (err_code != NRFX_SUCCESS) {
        return ARM_DRIVER_ERROR_PARAMETER;
    }
#else
    /*
     * Erasure is not needed on RRAM.
     * Save lifetime and execution time by not emulating a flash erase.
     */
#endif

    return ARM_DRIVER_OK;
}

static ARM_FLASH_INFO * ARM_Flash_GetInfo(void)
{
    return &FlashInfo;
}

ARM_DRIVER_FLASH Driver_FLASH0 = {
    .GetVersion      = NULL,
    .GetCapabilities = ARM_Flash_GetCapabilities,
    .Initialize      = ARM_Flash_Initialize,
    .Uninitialize    = ARM_Flash_Unitialize,
    .PowerControl    = NULL,
    .ReadData        = ARM_Flash_ReadData,
    .ProgramData     = ARM_Flash_ProgramData,
    .EraseSector     = ARM_Flash_EraseSector,
    .EraseChip       = NULL,
    .GetStatus       = NULL,
    .GetInfo         = ARM_Flash_GetInfo
};

#endif /* RTE_FLASH0 */
