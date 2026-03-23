/*
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

#include "spu.h"
#include "region_defs.h"
#include "array.h"

/* Platform-specific configuration */
#if NRF_SPU_HAS_MEMORY

#define DEVICE_FLASH_BASE_ADDRESS FLASH_BASE_ADDRESS
#define DEVICE_SRAM_BASE_ADDRESS SRAM_BASE_ADDRESS

#define FLASH_SECURE_ATTRIBUTION_REGION_SIZE SPU_FLASH_REGION_SIZE
#define SRAM_SECURE_ATTRIBUTION_REGION_SIZE  SPU_SRAM_REGION_SIZE

#define FLASH_SECURE_ATTRIBUTION_REGIONS_START_ID 0
#define SRAM_SECURE_ATTRIBUTION_REGIONS_START_ID  64

#define NUM_FLASH_SECURE_ATTRIBUTION_REGIONS \
    (FLASH_TOTAL_SIZE / FLASH_SECURE_ATTRIBUTION_REGION_SIZE)
#define NUM_SRAM_SECURE_ATTRIBUTION_REGIONS \
    (TOTAL_RAM_SIZE / SRAM_SECURE_ATTRIBUTION_REGION_SIZE)

/* Convenience macros for SPU Non-Secure Callable (NCS) attribution */

/*
 * Determine the SPU Region number the given address belongs to.
 *
 * addr shall be a valid flash memory address
 */
#define FLASH_NSC_REGION_FROM_ADDR(addr) \
    ((uint32_t)addr / FLASH_SECURE_ATTRIBUTION_REGION_SIZE)

/*
 * Determine the NSC region size based on a given NCS region base address.
 */
#define FLASH_NSC_SIZE_FROM_ADDR(addr) (FLASH_SECURE_ATTRIBUTION_REGION_SIZE \
    - (((uint32_t)(addr)) % FLASH_SECURE_ATTRIBUTION_REGION_SIZE))

/*
 * Determine the encoded the SPU NCS Region Size value,
 * based on the absolute NCS region size in bytes.
 *
 * size shall be a valid SPU NCS Region size value
 */
#define FLASH_NSC_SIZE_REG(size) ((31 - __builtin_clz(size)) - 4)

#if defined(REGION_MCUBOOT_ADDRESS) || defined(REGION_B0_ADDRESS) || defined(REGION_S0_ADDRESS) || defined(REGION_S1_ADDRESS)
static bool spu_region_is_flash_region_in_address_range(uint8_t region_id, uint32_t start_address, uint32_t end_address)
{
    size_t start_id = (start_address - DEVICE_FLASH_BASE_ADDRESS) / FLASH_SECURE_ATTRIBUTION_REGION_SIZE;
    size_t end_id = (end_address - DEVICE_FLASH_BASE_ADDRESS) / FLASH_SECURE_ATTRIBUTION_REGION_SIZE;
    return region_id >= start_id && region_id <= end_id;
}
#endif

static bool spu_region_is_bootloader_region(NRF_SPU_Type * p_reg, uint8_t region_id)
{
    bool is_bootloader = false;

#ifdef REGION_MCUBOOT_ADDRESS
    is_bootloader = is_bootloader || spu_region_is_flash_region_in_address_range(region_id, REGION_MCUBOOT_ADDRESS, REGION_MCUBOOT_LIMIT);
#endif
#ifdef REGION_B0_ADDRESS
    is_bootloader = is_bootloader || spu_region_is_flash_region_in_address_range(region_id, REGION_B0_ADDRESS, REGION_B0_LIMIT);
#endif
#ifdef REGION_S0_ADDRESS
    is_bootloader = is_bootloader || spu_region_is_flash_region_in_address_range(region_id, REGION_S0_ADDRESS, REGION_S0_LIMIT);
#endif
#ifdef REGION_S1_ADDRESS
    is_bootloader = is_bootloader || spu_region_is_flash_region_in_address_range(region_id, REGION_S1_ADDRESS, REGION_S1_LIMIT);
#endif

    return is_bootloader;
}

#endif /* NRF_SPU_HAS_MEMORY */

void spu_enable_interrupts(void)
{
	uint32_t mask = 0;

#if NRF_SPU_HAS_MEMORY
    mask |= NRF_SPU_INT_RAMACCERR_MASK;
	mask |= NRF_SPU_INT_FLASHACCERR_MASK;
#endif

    mask |= NRF_SPU_INT_PERIPHACCERR_MASK;

	for(int i = 0; i < ARRAY_SIZE(spu_instances); i++) {
		nrf_spu_int_enable(spu_instances[i], mask);
	}
}

uint32_t spu_events_get(void)
{
    uint32_t events = 0;

    for(int i = 0; i < ARRAY_SIZE(spu_instances); i++) {
        if(nrf_spu_event_check(spu_instances[i], NRF_SPU_EVENT_PERIPHACCERR)){
            events |= SPU_EVENT_PERIPHACCERR;
        }
#if NRF_SPU_HAS_MEMORY
        if (nrf_spu_event_check(spu_instances[i], NRF_SPU_EVENT_RAMACCERR)) {
            events |= SPU_EVENT_RAMACCERR;
        }
        if (nrf_spu_event_check(spu_instances[i], NRF_SPU_EVENT_FLASHACCERR)) {
            events |= SPU_EVENT_FLASHACCERR;
        }
#endif /* NRF_SPU_HAS_MEMORY */
    }

    return events;
}

#ifdef MPC_PRESENT
void mpc_enable_interrupts(void)
{
    uint32_t mask = NRF_MPC_INT_MEMACCERR_MASK;
    nrf_mpc_int_enable(NRF_MPC00, mask);
}

uint32_t mpc_events_get(void)
{
    uint32_t events = 0;

    if (nrf_mpc_event_check(NRF_MPC00, NRF_MPC_EVENT_MEMACCERR)){
        events |= MPC_EVENT_MEMACCERR;
    }

    return events;
}

void mpc_clear_events()
{
    nrf_mpc_event_clear(NRF_MPC00, NRF_MPC_EVENT_MEMACCERR);
}
#endif /* MPC_PRESENT */

void spu_clear_events(void)
{
	for(int i = 0; i < ARRAY_SIZE(spu_instances); i++) {
#if NRF_SPU_HAS_MEMORY
		nrf_spu_event_clear(spu_instances[i], NRF_SPU_EVENT_RAMACCERR);
		nrf_spu_event_clear(spu_instances[i], NRF_SPU_EVENT_FLASHACCERR);
#endif
		nrf_spu_event_clear(spu_instances[i], NRF_SPU_EVENT_PERIPHACCERR);
	}
}

#ifdef SPU_PERIPHACCERR_ADDRESS_ADDRESS_Msk
uint32_t spu_get_peri_addr(void) {
    uint32_t addr = 0;

    for(int i = 0; i < ARRAY_SIZE(spu_instances); i++) {
        if(spu_instances[i]->EVENTS_PERIPHACCERR){
            /* Only the lower 16 bits of the address are captured into the register. The upper
             * 16 bits correspond to the upper 16 bits of the SPU's base address.
             */
            addr = spu_instances[i]->PERIPHACCERR.ADDRESS | ((uint32_t)spu_instances[i] & 0xFFFF0000);
        }
    }

    return addr;
}
#endif

#if NRF_SPU_HAS_MEMORY
void spu_regions_reset_unlocked_secure(void)
{
    for (size_t i = 0; i < NUM_FLASH_SECURE_ATTRIBUTION_REGIONS ; i++) {
        if (!spu_region_is_bootloader_region(NRF_SPU, i)) {
            nrf_spu_flashregion_set(NRF_SPU, i,
                SPU_SECURE_ATTR_SECURE,
                NRF_SPU_MEM_PERM_READ
                | NRF_SPU_MEM_PERM_WRITE
                | NRF_SPU_MEM_PERM_EXECUTE,
                SPU_LOCK_CONF_UNLOCKED);
        }
    }

    for (size_t i = 0; i < NUM_SRAM_SECURE_ATTRIBUTION_REGIONS ; i++) {
        nrf_spu_ramregion_set(NRF_SPU, i,
            SPU_SECURE_ATTR_SECURE,
            NRF_SPU_MEM_PERM_READ
            | NRF_SPU_MEM_PERM_WRITE
            | NRF_SPU_MEM_PERM_EXECUTE,
            SPU_LOCK_CONF_UNLOCKED);
    }
}

void spu_regions_flash_config(uint32_t start_addr, uint32_t limit_addr, bool secure_attr,
			      uint32_t permissions, bool lock_conf)
{
    /* Determine start and last flash region number */
    size_t start_id =
        (start_addr - DEVICE_FLASH_BASE_ADDRESS) /
            FLASH_SECURE_ATTRIBUTION_REGION_SIZE;
    size_t last_id =
        (limit_addr - DEVICE_FLASH_BASE_ADDRESS) /
            FLASH_SECURE_ATTRIBUTION_REGION_SIZE;

    /* Configure all flash regions between start_id and last_id */
    for (size_t i = start_id; i <= last_id; i++) {
        nrf_spu_flashregion_set(NRF_SPU, i, secure_attr, permissions, lock_conf);
    }
}

void spu_regions_sram_config(uint32_t start_addr, uint32_t limit_addr, bool secure_attr,
			      uint32_t permissions, bool lock_conf)
{
    /* Determine start and last ram region number */
    size_t start_id =
        (start_addr - DEVICE_SRAM_BASE_ADDRESS) /
            SRAM_SECURE_ATTRIBUTION_REGION_SIZE;
    size_t last_id =
        (limit_addr - DEVICE_SRAM_BASE_ADDRESS) /
            SRAM_SECURE_ATTRIBUTION_REGION_SIZE;

    /* Configure all ram regions between start_id and last_id */
    for (size_t i = start_id; i <= last_id; i++) {
        nrf_spu_ramregion_set(NRF_SPU, i, secure_attr, permissions, lock_conf);
    }
}

void spu_regions_flash_config_non_secure_callable(uint32_t start_addr,
    uint32_t limit_addr)
{
    size_t size = limit_addr - start_addr + 1;

    uint32_t nsc_size = FLASH_NSC_SIZE_FROM_ADDR(start_addr);

    /* Check Non-Secure Callable region possible overflow */
    NRFX_ASSERT(size <= nsc_size);

    /* Check Non-Secure Callable region ending on SPU boundary */
    NRFX_ASSERT(((start_addr + nsc_size) %
            FLASH_SECURE_ATTRIBUTION_REGION_SIZE) == 0);

    /* Check Non-Secure Callable region power-of-2 size compliance */
    NRFX_ASSERT((nsc_size & (nsc_size - 1)) == 0);

    /* Check Non-Secure Callable region size is within [32, 4096] range */
    NRFX_ASSERT((nsc_size >= 32) && (nsc_size <= 4096));

    nrf_spu_flashnsc_set(NRF_SPU, 0,
        FLASH_NSC_SIZE_REG(nsc_size),
        FLASH_NSC_REGION_FROM_ADDR(start_addr),
        SPU_LOCK_CONF_LOCKED);
}

uint32_t spu_regions_flash_get_base_address_in_region(uint32_t region_id)
{
    return FLASH_BASE_ADDRESS +
        ((region_id - FLASH_SECURE_ATTRIBUTION_REGIONS_START_ID) *
            FLASH_SECURE_ATTRIBUTION_REGION_SIZE);
}

uint32_t spu_regions_flash_get_last_address_in_region(uint32_t region_id)
{
    return FLASH_BASE_ADDRESS +
        ((region_id - FLASH_SECURE_ATTRIBUTION_REGIONS_START_ID + 1) *
            FLASH_SECURE_ATTRIBUTION_REGION_SIZE) - 1;
}

uint32_t spu_regions_flash_get_start_id(void) {

    return FLASH_SECURE_ATTRIBUTION_REGIONS_START_ID;
}

uint32_t spu_regions_flash_get_last_id(void) {

    return FLASH_SECURE_ATTRIBUTION_REGIONS_START_ID +
        NUM_FLASH_SECURE_ATTRIBUTION_REGIONS - 1;
}

uint32_t spu_regions_flash_get_region_size(void) {

    return FLASH_SECURE_ATTRIBUTION_REGION_SIZE;
}

uint32_t spu_regions_sram_get_base_address_in_region(uint32_t region_id)
{
    return SRAM_BASE_ADDRESS +
        ((region_id - SRAM_SECURE_ATTRIBUTION_REGIONS_START_ID) *
            SRAM_SECURE_ATTRIBUTION_REGION_SIZE);
}

uint32_t spu_regions_sram_get_last_address_in_region(uint32_t region_id)
{
    return SRAM_BASE_ADDRESS +
        ((region_id - SRAM_SECURE_ATTRIBUTION_REGIONS_START_ID + 1) *
            SRAM_SECURE_ATTRIBUTION_REGION_SIZE) - 1;
}

uint32_t spu_regions_sram_get_start_id(void) {

    return SRAM_SECURE_ATTRIBUTION_REGIONS_START_ID;
}

uint32_t spu_regions_sram_get_last_id(void) {

    return SRAM_SECURE_ATTRIBUTION_REGIONS_START_ID +
        NUM_SRAM_SECURE_ATTRIBUTION_REGIONS - 1;
}

uint32_t spu_regions_sram_get_region_size(void) {

    return SRAM_SECURE_ATTRIBUTION_REGION_SIZE;
}

#endif /* NRF_SPU_HAS_MEMORY */

void spu_peripheral_config_secure(const uint32_t periph_base_address, bool periph_lock)
{
    uint8_t periph_id = NRFX_PERIPHERAL_ID_GET(periph_base_address);

#if NRF_SPU_HAS_MEMORY
    /* ASSERT checking that this is not an explicit Non-Secure peripheral */
    NRFX_ASSERT((NRF_SPU->PERIPHID[periph_id].PERM &
        SPU_PERIPHID_PERM_SECUREMAPPING_Msk) !=
        (SPU_PERIPHID_PERM_SECUREMAPPING_NonSecure <<
            SPU_PERIPHID_PERM_SECUREMAPPING_Pos));

    nrf_spu_peripheral_set(NRF_SPU, periph_id,
        1 /* Secure */,
        1 /* Secure DMA */,
        periph_lock);

#else

	NRF_SPU_Type * nrf_spu = spu_instance_from_peripheral_addr(periph_base_address);

    uint8_t spu_id = NRFX_PERIPHERAL_ID_GET(nrf_spu);

	uint8_t index = periph_id - spu_id;

	nrf_spu_periph_perm_secattr_set(nrf_spu, index, true /* Secure */);
	nrf_spu_periph_perm_dmasec_set(nrf_spu, index, true /* Secure */);
	nrf_spu_periph_perm_lock_enable(nrf_spu, index);
#endif
}

void spu_peripheral_config_non_secure(const uint32_t periph_base_address, bool periph_lock)
{
    uint8_t periph_id = NRFX_PERIPHERAL_ID_GET(periph_base_address);

#if NRF_SPU_HAS_MEMORY
    /* ASSERT checking that this is not an explicit Secure peripheral */
    NRFX_ASSERT((NRF_SPU->PERIPHID[periph_id].PERM &
        SPU_PERIPHID_PERM_SECUREMAPPING_Msk) !=
        (SPU_PERIPHID_PERM_SECUREMAPPING_Secure <<
            SPU_PERIPHID_PERM_SECUREMAPPING_Pos));

    nrf_spu_peripheral_set(NRF_SPU, periph_id,
        0 /* Non-Secure */,
        0 /* Non-Secure DMA */,
        periph_lock);
#else
	NRF_SPU_Type * nrf_spu = spu_instance_from_peripheral_addr(periph_base_address);

    uint8_t spu_id = NRFX_PERIPHERAL_ID_GET(nrf_spu);

	uint8_t index = periph_id - spu_id;

	nrf_spu_periph_perm_secattr_set(nrf_spu, index, false /* Non-Secure */);
	nrf_spu_periph_perm_dmasec_set(nrf_spu, index, false /* Non-Secure */);
	nrf_spu_periph_perm_lock_enable(nrf_spu, index);
#endif
}
