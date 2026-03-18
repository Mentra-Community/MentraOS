/*
 * Copyright (c) 2017-2023, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_PLAT_CRYPTO_KEYS_H__
#define __TFM_PLAT_CRYPTO_KEYS_H__

#include <stdint.h>
#include "psa/crypto.h"
#include "tfm_plat_defs.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * \brief Callback function type platform key loader functions
 *
 * This function pointer type defines the prototype for a builtin key loader function so that the
 * key can be probed by the tfm_builtin_key_loader driver during the init phase. Note that the key
 * must be readable from the secure processing element to be able to use the tfm_builtin_key_loader
 *
 * \param[out] buf       Buffer to hold the retrieved key material from the platform
 * \param[in]  buf_len   Size of the buf buffer
 * \param[out] key_len   Actual length of the key material in bytes retrieved from the platform
 * \param[out] key_bits  Size in bits of the key (important for those keys that are not
 *                       byte-multiple or encoded in different format than raw bytes)
 * \param[out] algorithm \ref psa_algorithm_t value associated to the retrieved key material
 * \param[out] type      \ref psa_key_type_t value associated to the retrieved key material
 *
 * \return Returns an error value as specified by the \ref tfm_plat_err_t type.
 *
 */
typedef enum tfm_plat_err_t (*key_loader_func_ptr)
    (uint8_t *buf, size_t buf_len, size_t *key_len, psa_key_bits_t *key_bits, psa_algorithm_t *algorithm, psa_key_type_t *type);

/**
 * \brief This type describes the information that each TF-M builtin key
 *        must key in the associated descriptor table in \ref crypto_keys.c
 */
typedef struct {
    psa_key_id_t key_id;                 /*!< Key id associated to the builtin key */
    psa_drv_slot_number_t slot_number;   /*!< Slot number for the builtin key in the platform */
    psa_key_lifetime_t lifetime;         /*!< Lifetime (persistence + location) for the builtin key */
    key_loader_func_ptr loader_key_func; /*!< Loader function that reads the key from the platform */
} tfm_plat_builtin_key_descriptor_t;

/**
 * \brief This function retrieves a pointer to the description table for builtin keys. Each platform
 *        must implement this table with the details of the builtin keys available in the platform
 *
 * \param[out] desc_ptr A pointer to the description table
 *
 * \return size_t The number of builtin keys available in the platform
 */
size_t tfm_plat_builtin_key_get_desc_table_ptr(const tfm_plat_builtin_key_descriptor_t *desc_ptr[]);

/**
 * \brief This type maps a particular user of a builtin key (i.e. an owner) to
 *        the allowed usage (i.e. a policy) as specified by the platform
 */
typedef struct {
    int32_t user;
    psa_key_usage_t usage;
} tfm_plat_builtin_key_per_user_policy_t;

/**
 * \brief This type maps a particular key_id associated to a builtin key to the
 *        allowed usage (i.e. a policy). The policy can be user specific in case
 *        the per_user_policy field is greater than 0. In that case policy_ptr needs
 *        to be used to access the policies for each user of the key_id which are of
 *        type \ref tfm_platf_builtin_key_per_user_policy_t
 */
typedef struct {
    psa_key_id_t key_id;
    size_t per_user_policy;
    union {
        psa_key_usage_t usage;
        const tfm_plat_builtin_key_per_user_policy_t *policy_ptr;
    };
} tfm_plat_builtin_key_policy_t;

/**
 * \brief This function retrieves a pointer to the policy table of the builtin keys. Each platform
 *        must implement this table with the details of the builtin keys available in the platform
 *
 * \param[out] desc_ptr A pointer to the policy table
 *
 * \return size_t The number of builtin keys available in the platform with associated policies
 */
size_t tfm_plat_builtin_key_get_policy_table_ptr(const tfm_plat_builtin_key_policy_t *desc_ptr[]);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_PLAT_CRYPTO_KEYS_H__ */
