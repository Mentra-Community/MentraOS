/*
 * Copyright (c) 2021 - 2023 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

#include <stddef.h>

#include "psa/crypto_types.h"
#include "tfm_plat_crypto_keys.h"
#include "tfm_builtin_key_ids.h"
#include "tfm_builtin_key_loader.h"
#include "psa_manifest/pid.h"
#include "tfm_spm_log.h"

#ifdef CONFIG_HW_UNIQUE_KEY
#include <hw_unique_key.h>
#endif

#include <identity_key.h>

#define MAPPED_TZ_NS_AGENT_DEFAULT_CLIENT_ID -0x3c000000
#define TFM_NS_PARTITION_ID                  MAPPED_TZ_NS_AGENT_DEFAULT_CLIENT_ID

#ifdef CONFIG_HW_UNIQUE_KEY
static enum tfm_plat_err_t tfm_plat_get_huk(uint8_t *buf, size_t buf_len, size_t *key_len,
					    psa_key_bits_t *key_bits, psa_algorithm_t *algorithm,
					    psa_key_type_t *type)
{
	if (buf_len < HUK_SIZE_BYTES) {
		return TFM_PLAT_ERR_SYSTEM_ERR;
	}

	uint8_t label[] = "TFM_HW_UNIQ_KEY";

	int err = hw_unique_key_derive_key(HUK_KEYSLOT_MEXT, NULL, 0, label, sizeof(label), buf,
					   buf_len);

	if (err != HW_UNIQUE_KEY_SUCCESS) {
		SPMLOG_DBGMSGVAL("hw_unique_key_derive_key err: ", err);

		return TFM_PLAT_ERR_SYSTEM_ERR;
	}

	*key_len = HUK_SIZE_BYTES;
	*key_bits = HUK_SIZE_BYTES * 8;
	*algorithm = PSA_ALG_HKDF(PSA_ALG_SHA_256);
	*type = PSA_KEY_TYPE_DERIVE;

	return TFM_PLAT_ERR_SUCCESS;
}
#endif /* CONFIG_HW_UNQUE_KEY */

#ifdef TFM_PARTITION_INITIAL_ATTESTATION
static enum tfm_plat_err_t tfm_plat_get_iak(uint8_t *buf, size_t buf_len, size_t *key_len,
					    psa_key_bits_t *key_bits, psa_algorithm_t *algorithm,
					    psa_key_type_t *type)
{
	int err;

	if (buf_len < IDENTITY_KEY_SIZE_BYTES) {
		return TFM_PLAT_ERR_SYSTEM_ERR;
	}

	err = identity_key_read(buf);
	if (err != IDENTITY_KEY_SUCCESS) {
		SPMLOG_DBGMSGVAL("identity_key_read err: ", err);

		return TFM_PLAT_ERR_SYSTEM_ERR;
	}

	*key_len = IDENTITY_KEY_SIZE_BYTES;
	*key_bits = IDENTITY_KEY_SIZE_BYTES * 8;
	*algorithm = PSA_ALG_ECDSA(PSA_ALG_SHA_256);
	*type = PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1);

	return TFM_PLAT_ERR_SUCCESS;
}

/**
 * @brief Table describing per-user key policy for the IAK
 *
 */
static const tfm_plat_builtin_key_per_user_policy_t g_iak_per_user_policy[] = {
	{
		.user = TFM_SP_INITIAL_ATTESTATION,
#ifdef SYMMETRIC_INITIAL_ATTESTATION
		.usage = PSA_KEY_USAGE_SIGN_HASH | PSA_KEY_USAGE_EXPORT,
#else
		.usage = PSA_KEY_USAGE_SIGN_HASH,
#endif /* SYMMETRIC_INITIAL_ATTESTATION */
	},
#ifdef TEST_S_ATTESTATION
	{.user = TFM_SP_SECURE_TEST_PARTITION, .usage = PSA_KEY_USAGE_VERIFY_HASH},
#endif /* TEST_S_ATTESTATION */
#ifdef TEST_NS_ATTESTATION
	{.user = TFM_NS_PARTITION_ID, .usage = PSA_KEY_USAGE_VERIFY_HASH},
#endif /* TEST_NS_ATTESTATION */
};
#endif /* TFM_PARTITION_INITIAL_ATTESTATION */

/**
 * @brief Table describing per-key user policies
 *
 */
#if defined(CONFIG_HW_UNIQUE_KEY) || defined(TFM_PARTITION_INITIAL_ATTESTATION)
static const tfm_plat_builtin_key_policy_t g_builtin_keys_policy[] = {
#ifdef CONFIG_HW_UNIQUE_KEY
	{.key_id = TFM_BUILTIN_KEY_ID_HUK, .per_user_policy = 0, .usage = PSA_KEY_USAGE_DERIVE},
#endif /* CONFIG_HW_UNIQUE_KEY */
#ifdef TFM_PARTITION_INITIAL_ATTESTATION
	{.key_id = TFM_BUILTIN_KEY_ID_IAK,
	 .per_user_policy = ARRAY_SIZE(g_iak_per_user_policy),
	 .policy_ptr = g_iak_per_user_policy},
#endif /* TFM_PARTITION_INITIAL_ATTESTATION */
};
#endif /* defined(CONFIG_HW_UNIQUE_KEY) || defined(TFM_PARTITION_INITIAL_ATTESTATION) */

/**
 * @brief Table describing the builtin-in keys (plaform keys) available in the platform. Note
 *        that to bind the keys to the tfm_builtin_key_loader driver, the lifetime must be
 *        explicitly set to the one associated to the driver, i.e. TFM_BUILTIN_KEY_LOADER_LIFETIME
 */
#if defined(CONFIG_HW_UNIQUE_KEY) || defined(TFM_PARTITION_INITIAL_ATTESTATION)
static const tfm_plat_builtin_key_descriptor_t g_builtin_keys_desc[] = {
#ifdef CONFIG_HW_UNIQUE_KEY
	{.key_id = TFM_BUILTIN_KEY_ID_HUK,
	 .slot_number = TFM_BUILTIN_KEY_SLOT_HUK,
	 .lifetime = TFM_BUILTIN_KEY_LOADER_LIFETIME,
	 .loader_key_func = tfm_plat_get_huk},
#endif /* CONFIG_HW_UNIQUE_KEY */
#ifdef TFM_PARTITION_INITIAL_ATTESTATION
	{.key_id = TFM_BUILTIN_KEY_ID_IAK,
	 .slot_number = TFM_BUILTIN_KEY_SLOT_IAK,
	 .lifetime = TFM_BUILTIN_KEY_LOADER_LIFETIME,
	 .loader_key_func = tfm_plat_get_iak},
#endif /* TFM_PARTITION_INITIAL_ATTESTATION */
	{},
};
#endif /* defined(CONFIG_HW_UNIQUE_KEY) || defined(TFM_PARTITION_INITIAL_ATTESTATION) */

size_t tfm_plat_builtin_key_get_policy_table_ptr(const tfm_plat_builtin_key_policy_t *desc_ptr[])
{
#if defined(CONFIG_HW_UNIQUE_KEY) || defined(TFM_PARTITION_INITIAL_ATTESTATION)
	*desc_ptr = &g_builtin_keys_policy[0];
	return ARRAY_SIZE(g_builtin_keys_policy);
#else
	return 0;
#endif
}

size_t tfm_plat_builtin_key_get_desc_table_ptr(const tfm_plat_builtin_key_descriptor_t *desc_ptr[])
{
#if defined(CONFIG_HW_UNIQUE_KEY) || defined(TFM_PARTITION_INITIAL_ATTESTATION)
	*desc_ptr = &g_builtin_keys_desc[0];
	return ARRAY_SIZE(g_builtin_keys_desc);
#else
	return 0;
#endif /* defined(CONFIG_HW_UNIQUE_KEY) || defined(TFM_PARTITION_INITIAL_ATTESTATION) */
}
