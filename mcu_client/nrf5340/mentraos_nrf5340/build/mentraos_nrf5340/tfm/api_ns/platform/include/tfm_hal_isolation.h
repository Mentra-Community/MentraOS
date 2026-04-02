/*
 * Copyright (c) 2020-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_HAL_ISOLATION_H__
#define __TFM_HAL_ISOLATION_H__

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include "fih.h"
#include "tfm_hal_defs.h"
#include "load/partition_defs.h"
#include "load/asset_defs.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Memory access attributes */
#define TFM_HAL_ACCESS_EXECUTABLE       (1UL << 0)
#define TFM_HAL_ACCESS_READABLE         (1UL << 1)
#define TFM_HAL_ACCESS_WRITABLE         (1UL << 2)
#define TFM_HAL_ACCESS_UNPRIVILEGED     (1UL << 3)
#define TFM_HAL_ACCESS_DEVICE           (1UL << 4)
#define TFM_HAL_ACCESS_NS               (1UL << 5)

#define TFM_HAL_ACCESS_READWRITE  \
        (TFM_HAL_ACCESS_READABLE | TFM_HAL_ACCESS_WRITABLE)

#ifdef TFM_FIH_PROFILE_ON

/**
 * \brief This function is responsible for checking all critical isolation
          configurations.
 *
 * \return TFM_HAL_SUCCESS - the verification passed.
 *         TFM_HAL_ERROR_GENERIC - the verification failed.
 */
fih_int tfm_hal_verify_static_boundaries(void);

#endif /* TFM_FIH_PROFILE_ON */
/**
 * \brief  Sets up the static isolation boundaries which are constant throughout
 *         the runtime of the system, including the SPE/NSPE and partition
 *         boundaries.
 *
 * \param[out]   p_spm_boundary    Pointer of the boundary value
 *
 * \return TFM_HAL_SUCCESS - the isolation boundaries have been set up.
 *         TFM_HAL_ERROR_GENERIC - failed to set up the isolation boundaries.
 */
FIH_RET_TYPE(enum tfm_hal_status_t) tfm_hal_set_up_static_boundaries(
                                                uintptr_t *p_spm_boundary);

/**
 * \brief  Activate one Secure Partition boundary.
 *
 * \param[in]   p_ldinf         Partition load information.
 * \param[in]   boundary        Platform boundary value for partition.
 *
 * \return TFM_HAL_SUCCESS          The isolation boundaries update succeeded.
 *         TFM_HAL_ERROR_GENERIC    Failed to update the isolation boundaries.
 */
FIH_RET_TYPE(enum tfm_hal_status_t) tfm_hal_activate_boundary(
                            const struct partition_load_info_t *p_ldinf,
                            uintptr_t boundary);

/**
 * \brief  This API checks if a given range of memory can be accessed with
 *         specified access types in boundary. The boundary belongs to
 *         a partition which contains all asset info.
 *
 * \param[in]   boundary      The boundary that the given memory is to be
 *                            checked with.
 * \param[in]   base          The base address of the region.
 * \param[in]   size          The size of the region.
 * \param[in]   access_type   The memory access types to be checked between
 *                            given memory and boundaries.
 *
 * \return TFM_HAL_SUCCESS - The memory region has the access permissions.
 *         TFM_HAL_ERROR_MEM_FAULT - The memory region has not the access
 *                                   permissions.
 *         TFM_HAL_ERROR_INVALID_INPUT - Invalid inputs.
 *         TFM_HAL_ERROR_GENERIC - An error occurred.
 */
FIH_RET_TYPE(enum tfm_hal_status_t) tfm_hal_memory_check(
                                           uintptr_t boundary, uintptr_t base,
                                           size_t size, uint32_t access_type);

/**
 * \brief  This API binds partition boundaries with the platform. The platform
 *         maintains the platform-specific settings for SPM further
 *         usage, such as update partition boundaries or
 *         check resource accessibility. The platform needs to manage
 *         the settings with internal mechanism, and return a value
 *         to SPM. SPM delivers this value back to platform when
 *         necessary. And SPM checks this value to decide if the
 *         platform-specific settings need to be updated. Hence
 *         multiple partitions can have the same value if they have
 *         the same platform-specific settings, depending on isolation level.
 *
 * \param[in]   p_ldinf           Partition load information.
 * \param[in]   p_boundary        Pointer of the boundary value
 *
 * \return TFM_HAL_SUCCESS          - A platform value bound successfully.
 *         TFM_HAL_ERROR_GENERIC    - Error occurred while binding.
 */
FIH_RET_TYPE(enum tfm_hal_status_t) tfm_hal_bind_boundary(
                                    const struct partition_load_info_t *p_ldinf,
                                    uintptr_t *p_boundary);

/**
 * \brief  This API let the platform decide if a boundary switch is needed.
 *
 * \param[in]   boundary_from  The current boundary to be switched.
 * \param[in]   boundary_to    The target boundary to be switched to.
 *
 * \return true  - a switching is needed.
 *         false - do not need a switch.
 */
FIH_RET_TYPE(bool) tfm_hal_boundary_need_switch(uintptr_t boundary_from,
                                                uintptr_t boundary_to);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_HAL_ISOLATION_H__ */
