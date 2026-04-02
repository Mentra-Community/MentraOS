/*
 * Copyright (c) 2019-2024, Arm Limited. All rights reserved.
 * Copyright (c) 2020 STMicroelectronics. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __BOOT_HAL_H__
#define __BOOT_HAL_H__

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "cmsis_compiler.h"

/* Include header section */

#ifdef __cplusplus
extern "C" {
#endif

struct boot_arm_vector_table {
    uint32_t msp;
    uint32_t reset;
};

/*
 * \brief It clears that part of the RAM which was used by MCUBoot, expect the
 *        TFM_SHARED_DATA area, which is used to pass data to the TF-M runtime.
 *
 * \note  This function must be implemented per target platform by system
 *        integrator. If the bootloader has not loaded any secret to the shared
 *        RAM then this function can immediately return to shorten the boot-up
 *        time. Clearing RAM area can be done several way, it is platform
 *        dependent:
 *        - Overwritten with a pre-defined constant value (i.e.: 0).
 *        - Overwritten with a random value.
 *        - Change the secret if its location is known.
 *        - Set a register which can hide some part of the flash/RAM against
 *          next stage software components.
 *        - Etc.
 */
void boot_clear_ram_area(void);

/*
 * \brief Chain-loading the next image in the boot sequence.
 *        Can be overridden for platform specific initialization.
 * \param[in] reset_handler_addr Address of next image's Reset_Handler() in
                                 the boot chain (TF-M SPE, etc.)
 */
__NO_RETURN void boot_jump_to_next_image(uint32_t reset_handler_addr);

/**
 * \brief Platform peripherals and devices initialization.
 *        Can be overridden for platform specific initialization.
 *
 * \return Returns 0 on success, non-zero otherwise
 */
int32_t boot_platform_init(void);

/**
 * \brief Perform later platform specific initialization. Runs at the end of the
 *        boot initialization phase, for platform-specific code that depends on
 *        other initialization code being run beforehand.
 *
 * \return Returns 0 on success, non-zero otherwise
 */
int32_t boot_platform_post_init(void);

/**
 * \brief Platform operation to start secure image.
 *        Can be overridden for platform specific initialization.
 *
 * \param[in] vt  pointer to secure application vector table descriptor
 */
__NO_RETURN void boot_platform_quit(struct boot_arm_vector_table *vt);

/**
 * \brief Platform operation to perform steps required before image load.
 *        Can be overridden for platform specific initialization.
 *
 * \param[in] image_id  The ID of the image that is about to be loaded.
 *
 * \return Returns 0 on success, non-zero otherwise
 */
int boot_platform_pre_load(uint32_t image_id);

/**
 * \brief Platform operation to perform steps required after image load.
 *        Can be overridden for platform specific initialization.
 *
 * \param[in] image_id  The ID of the image that has just been loaded.
 *
 * \return Returns 0 on success, non-zero otherwise
 */
int boot_platform_post_load(uint32_t image_id);

/**
 * \brief Platform operation to check if a particular image should be loaded.
 *
 * \param[in] image_id  The ID of the image that is being queried.
 *
 * \return Returns true if image should be loaded, false otherwise
 */
bool boot_platform_should_load_image(uint32_t image_id);

/**
 * Version of a SW component, to be encoded as "major.minor.revision+build_num".
 */
struct boot_measurement_version {
    uint8_t major;
    uint8_t minor;
    uint16_t revision;
    uint32_t build_num;
};

struct boot_measurement_metadata {
    uint32_t measurement_type;  /* Identifier of the measurement method
                                 * used to compute the measurement value.
                                 */
    uint8_t signer_id[64];      /* Signer identity (hash of public key). */
    size_t  signer_id_size;     /* Size of the signer's ID in bytes. */
    char sw_type[10];           /* Representing the role of the SW component. */
    struct boot_measurement_version sw_version; /* Version of the SW component */
};

/**
 * \brief Stores single boot measurement and associated metadata in a
 *        non-persistent storage to a known location.
 *
 * \note  The measurement values and associated metadata are stored at a known
 *        location where they can be accessed later at runtime from secure
 *        software.
 *
 * \param[in] index                 In which measurement slot to store,
 *                                  the largest allowed index is 63 (0x3F).
 * \param[in] measurement           Pointer to buffer that stores the
 *                                  measurement value.
 * \param[in] measurement_size      Size of the measurement value in bytes.
 * \param[in] metadata              Pointer to a structure, containing the
 *                                  associated metadata.
 * \param[in] lock_measurement      If true, it locks the measurement slot and
 *                                  it is not allowed the extend it anymore with
 *                                  additional measurement values.
 *
 * \return Returns 0 on success, non-zero otherwise.
 */
int boot_store_measurement(uint8_t index,
                           const uint8_t *measurement,
                           size_t measurement_size,
                           const struct boot_measurement_metadata *metadata,
                           bool lock_measurement);

/**
 * \brief Run when boot has failed to load any images. Allows for a
 *        platform-specific response.
 *
 * \note  Care must be taken when implementing this function that it preserves
 *        the security of the secure-boot chain.
 *
 * \param[in] image_id  The ID of the image that failed to validate.
 *
 * \return Returns zero if recovery succeeded, non-zero otherwise.
 */
int boot_initiate_recovery_mode(uint32_t image_id);

#ifdef __cplusplus
}
#endif

#endif /* __BOOT_HAL_H__ */
