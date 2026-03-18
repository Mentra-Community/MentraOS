/*
 * Copyright (c) 2018-2023, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#include <stdlib.h>
#include <string.h>

#include "tfm_crypto_defs.h"

#include "psa/client.h"
#include "psa_manifest/sid.h"

#define API_DISPATCH(in_vec, out_vec)          \
    psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL,  \
             in_vec, IOVEC_LEN(in_vec),        \
             out_vec, IOVEC_LEN(out_vec))
#define API_DISPATCH_NO_OUTVEC(in_vec)         \
    psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL,  \
             in_vec, IOVEC_LEN(in_vec),        \
             (psa_outvec *)NULL, 0)

/*!
 * \def CONFIG_TFM_CRYPTO_API_RENAME
 *
 * \brief By setting this to 1, system integrators can rename the symbols of the
 *        PSA Crypto APIs available in the TF-M interface. It allows flexibility
 *        for some integration setups where multiple providers of the PSA Crypto
 *        APIs are available at link time. Normally this configuration option
 *        should not be enabled when building the Secure interface because the
 *        secure partitions will just use the standard function names. By default
 *        it prepends the "tfm_crypto__" prefix.
 *
 * \note  This config option is not available through the TF-M configuration as
 *        it's for NS applications and system integrators to enable.
 */

/*!
 * \def TFM_CRYPTO_API(ret, fun)
 *
 * \brief Define the function signature of a TF-M Crypto API with return
 *        type \a ret and PSA Crypto API function name \a fun
 *
 * \param ret return type associated to the API
 * \param fun API name (e.g. a PSA Crypto API function name)
 *
 * \returns Function signature
 */

#if CONFIG_TFM_CRYPTO_API_RENAME == 1
#define TFM_CRYPTO_API(ret, fun) ret tfm_crypto__##fun
#else
#define TFM_CRYPTO_API(ret, fun) ret fun
#endif /* CONFIG_TFM_CRYPTO_API_RENAME */

TFM_CRYPTO_API(psa_status_t, psa_crypto_init)(void)
{
    /* Service init is performed during TFM boot up,
     * so application level initialisation is empty
     */
    return PSA_SUCCESS;
}

TFM_CRYPTO_API(psa_status_t, psa_open_key)(psa_key_id_t id,
                                           psa_key_id_t *key)
{
    const struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_OPEN_KEY_SID,
        .key_id = id,
    };
    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = key, .len = sizeof(psa_key_id_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_close_key)(psa_key_id_t key)
{
    const struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CLOSE_KEY_SID,
        .key_id = key,
    };
    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_import_key)(const psa_key_attributes_t *attributes,
                                             const uint8_t *data,
                                             size_t data_length,
                                             psa_key_id_t *key)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_IMPORT_KEY_SID,
    };
    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = attributes, .len = sizeof(psa_key_attributes_t)},
        {.base = data, .len = data_length}
    };
    psa_outvec out_vec[] = {
        {.base = key, .len = sizeof(psa_key_id_t)}
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_destroy_key)(psa_key_id_t key)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_DESTROY_KEY_SID,
        .key_id = key,
    };
    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_get_key_attributes)(psa_key_id_t key,
                                                     psa_key_attributes_t *attributes)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_GET_KEY_ATTRIBUTES_SID,
        .key_id = key,
    };
    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = attributes, .len = sizeof(psa_key_attributes_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_export_key)(psa_key_id_t key,
                                             uint8_t *data,
                                             size_t data_size,
                                             size_t *data_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_EXPORT_KEY_SID,
        .key_id = key,
    };
    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = data, .len = data_size}
    };

    status = API_DISPATCH(in_vec, out_vec);

    *data_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_export_public_key)(psa_key_id_t key,
                                                    uint8_t *data,
                                                    size_t data_size,
                                                    size_t *data_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_EXPORT_PUBLIC_KEY_SID,
        .key_id = key,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = data, .len = data_size}
    };

    status = API_DISPATCH(in_vec, out_vec);

    *data_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_purge_key)(psa_key_id_t key)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_PURGE_KEY_SID,
        .key_id = key,
    };
    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_copy_key)(psa_key_id_t source_key,
                                           const psa_key_attributes_t *attributes,
                                           psa_key_id_t *target_key)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_COPY_KEY_SID,
        .key_id = source_key,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = attributes, .len = sizeof(psa_key_attributes_t)},
    };

    psa_outvec out_vec[] = {
        {.base = target_key, .len = sizeof(psa_key_id_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_cipher_generate_iv)(psa_cipher_operation_t *operation,
                                                     unsigned char *iv,
                                                     size_t iv_size,
                                                     size_t *iv_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CIPHER_GENERATE_IV_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = iv, .len = iv_size},
    };

    status = API_DISPATCH(in_vec, out_vec);

    *iv_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_cipher_set_iv)(psa_cipher_operation_t *operation,
                                                const unsigned char *iv,
                                                size_t iv_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CIPHER_SET_IV_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = iv, .len = iv_length},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_cipher_encrypt_setup)(psa_cipher_operation_t *operation,
                                                       psa_key_id_t key,
                                                       psa_algorithm_t alg)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CIPHER_ENCRYPT_SETUP_SID,
        .key_id = key,
        .alg = alg,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_cipher_decrypt_setup)(psa_cipher_operation_t *operation,
                                                       psa_key_id_t key,
                                                       psa_algorithm_t alg)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CIPHER_DECRYPT_SETUP_SID,
        .key_id = key,
        .alg = alg,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_cipher_update)(psa_cipher_operation_t *operation,
                                                const uint8_t *input,
                                                size_t input_length,
                                                unsigned char *output,
                                                size_t output_size,
                                                size_t *output_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CIPHER_UPDATE_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
    };
    psa_outvec out_vec[] = {
        {.base = output, .len = output_size}
    };

    status = API_DISPATCH(in_vec, out_vec);

    *output_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_cipher_abort)(psa_cipher_operation_t *operation)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CIPHER_ABORT_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_cipher_finish)(psa_cipher_operation_t *operation,
                                                uint8_t *output,
                                                size_t output_size,
                                                size_t *output_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CIPHER_FINISH_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
        {.base = output, .len = output_size},
    };

    status = API_DISPATCH(in_vec, out_vec);

    *output_length = out_vec[1].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_hash_setup)(psa_hash_operation_t *operation,
                                             psa_algorithm_t alg)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_HASH_SETUP_SID,
        .alg = alg,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_hash_update)(psa_hash_operation_t *operation,
                                              const uint8_t *input,
                                              size_t input_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_HASH_UPDATE_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_hash_finish)(psa_hash_operation_t *operation,
                                              uint8_t *hash,
                                              size_t hash_size,
                                              size_t *hash_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_HASH_FINISH_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
        {.base = hash, .len = hash_size},
    };

    status = API_DISPATCH(in_vec, out_vec);

    *hash_length = out_vec[1].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_hash_verify)(psa_hash_operation_t *operation,
                                              const uint8_t *hash,
                                              size_t hash_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_HASH_VERIFY_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = hash, .len = hash_length},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_hash_abort)(psa_hash_operation_t *operation)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_HASH_ABORT_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_hash_clone)(const psa_hash_operation_t *source_operation,
                                             psa_hash_operation_t *target_operation)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_HASH_CLONE_SID,
        .op_handle = source_operation->handle,
    };

    if (target_operation && (target_operation->handle != 0)) {
        return PSA_ERROR_BAD_STATE;
    }

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = &(target_operation->handle),
         .len = sizeof(target_operation->handle)},
    };
    psa_outvec out_vec[] = {
        {.base = &(target_operation->handle),
         .len = sizeof(target_operation->handle)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_hash_compute)(psa_algorithm_t alg,
                                               const uint8_t *input,
                                               size_t input_length,
                                               uint8_t *hash,
                                               size_t hash_size,
                                               size_t *hash_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_HASH_COMPUTE_SID,
        .alg = alg,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
    };

    psa_outvec out_vec[] = {
        {.base = hash, .len = hash_size}
    };

    status = API_DISPATCH(in_vec, out_vec);

    *hash_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_hash_compare)(psa_algorithm_t alg,
                                               const uint8_t *input,
                                               size_t input_length,
                                               const uint8_t *hash,
                                               size_t hash_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_HASH_COMPARE_SID,
        .alg = alg,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
        {.base = hash, .len = hash_length},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_mac_sign_setup)(psa_mac_operation_t *operation,
                                                 psa_key_id_t key,
                                                 psa_algorithm_t alg)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_MAC_SIGN_SETUP_SID,
        .key_id = key,
        .alg = alg,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_mac_verify_setup)(psa_mac_operation_t *operation,
                                                   psa_key_id_t key,
                                                   psa_algorithm_t alg)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_MAC_VERIFY_SETUP_SID,
        .key_id = key,
        .alg = alg,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_mac_update)(psa_mac_operation_t *operation,
                                             const uint8_t *input,
                                             size_t input_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_MAC_UPDATE_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_mac_sign_finish)(psa_mac_operation_t *operation,
                                                  uint8_t *mac,
                                                  size_t mac_size,
                                                  size_t *mac_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_MAC_SIGN_FINISH_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
        {.base = mac, .len = mac_size},
    };

    status = API_DISPATCH(in_vec, out_vec);

    *mac_length = out_vec[1].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_mac_verify_finish)(psa_mac_operation_t *operation,
                                                    const uint8_t *mac,
                                                    size_t mac_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_MAC_VERIFY_FINISH_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = mac, .len = mac_length},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_mac_abort)(psa_mac_operation_t *operation)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_MAC_ABORT_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_aead_encrypt)(psa_key_id_t key,
                                               psa_algorithm_t alg,
                                               const uint8_t *nonce,
                                               size_t nonce_length,
                                               const uint8_t *additional_data,
                                               size_t additional_data_length,
                                               const uint8_t *plaintext,
                                               size_t plaintext_length,
                                               uint8_t *ciphertext,
                                               size_t ciphertext_size,
                                               size_t *ciphertext_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_ENCRYPT_SID,
        .key_id = key,
        .alg = alg,
        .aead_in = {.nonce = {0}, .nonce_length = 0}
    };

    /* Sanitize the optional input */
    if ((additional_data == NULL) && (additional_data_length != 0)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    psa_invec in_vec[] = {
        {.base = NULL, .len = 0},
        {.base = plaintext, .len = plaintext_length},
        {.base = additional_data, .len = additional_data_length},
    };
    psa_outvec out_vec[] = {
        {.base = ciphertext, .len = ciphertext_size},
    };

    if (nonce_length > TFM_CRYPTO_MAX_NONCE_LENGTH) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    if (nonce != NULL) {
        for (size_t idx = 0; idx < nonce_length; idx++) {
            iov.aead_in.nonce[idx] = nonce[idx];
        }
        iov.aead_in.nonce_length = nonce_length;
    }

    in_vec[0].base = &iov;
    in_vec[0].len = sizeof(struct tfm_crypto_pack_iovec);

    size_t in_len = IOVEC_LEN(in_vec);

    if (additional_data == NULL) {
        in_len--;
    }
    status = psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL, in_vec, in_len,
                      out_vec, IOVEC_LEN(out_vec));

    *ciphertext_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_decrypt)(psa_key_id_t key,
                                               psa_algorithm_t alg,
                                               const uint8_t *nonce,
                                               size_t nonce_length,
                                               const uint8_t *additional_data,
                                               size_t additional_data_length,
                                               const uint8_t *ciphertext,
                                               size_t ciphertext_length,
                                               uint8_t *plaintext,
                                               size_t plaintext_size,
                                               size_t *plaintext_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_DECRYPT_SID,
        .key_id = key,
        .alg = alg,
        .aead_in = {.nonce = {0}, .nonce_length = 0}
    };

    /* Sanitize the optional input */
    if ((additional_data == NULL) && (additional_data_length != 0)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    psa_invec in_vec[] = {
        {.base = NULL, .len = 0},
        {.base = ciphertext, .len = ciphertext_length},
        {.base = additional_data, .len = additional_data_length},
    };
    psa_outvec out_vec[] = {
        {.base = plaintext, .len = plaintext_size},
    };

    if (nonce_length > TFM_CRYPTO_MAX_NONCE_LENGTH) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    if (nonce != NULL) {
        for (size_t idx = 0; idx < nonce_length; idx++) {
            iov.aead_in.nonce[idx] = nonce[idx];
        }
        iov.aead_in.nonce_length = nonce_length;
    }

    in_vec[0].base = &iov;
    in_vec[0].len = sizeof(struct tfm_crypto_pack_iovec);

    size_t in_len = IOVEC_LEN(in_vec);

    if (additional_data == NULL) {
        in_len--;
    }
    status = psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL, in_vec, in_len,
                      out_vec, IOVEC_LEN(out_vec));

    *plaintext_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_encrypt_setup)(psa_aead_operation_t *operation,
                                                     psa_key_id_t key,
                                                     psa_algorithm_t alg)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_ENCRYPT_SETUP_SID,
        .key_id = key,
        .alg = alg,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)}
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)}
    };

    status = API_DISPATCH(in_vec, out_vec);
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_decrypt_setup)(psa_aead_operation_t *operation,
                                                     psa_key_id_t key,
                                                     psa_algorithm_t alg)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_DECRYPT_SETUP_SID,
        .key_id = key,
        .alg = alg,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)}
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)}
    };

    status = API_DISPATCH(in_vec, out_vec);
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_generate_nonce)(psa_aead_operation_t *operation,
                                                      uint8_t *nonce,
                                                      size_t nonce_size,
                                                      size_t *nonce_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_GENERATE_NONCE_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = nonce, .len = nonce_size}
    };

    status = API_DISPATCH(in_vec, out_vec);

    *nonce_length = out_vec[0].len;
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_set_nonce)(psa_aead_operation_t *operation,
                                                 const uint8_t *nonce,
                                                 size_t nonce_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_SET_NONCE_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = nonce, .len = nonce_length}
    };

    status = API_DISPATCH_NO_OUTVEC(in_vec);
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_set_lengths)(psa_aead_operation_t *operation,
                                                   size_t ad_length,
                                                   size_t plaintext_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_SET_LENGTHS_SID,
        .ad_length = ad_length,
        .plaintext_length = plaintext_length,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    status = API_DISPATCH_NO_OUTVEC(in_vec);
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_update_ad)(psa_aead_operation_t *operation,
                                                 const uint8_t *input,
                                                 size_t input_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_UPDATE_AD_SID,
        .op_handle = operation->handle,
    };

    /* Sanitize the optional input */
    if ((input == NULL) && (input_length != 0)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length}
    };

    size_t in_len = IOVEC_LEN(in_vec);

    if (input == NULL) {
        in_len--;
    }
    status = psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL, in_vec, in_len,
                      NULL, 0);
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_update)(psa_aead_operation_t *operation,
                                              const uint8_t *input,
                                              size_t input_length,
                                              uint8_t *output,
                                              size_t output_size,
                                              size_t *output_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_UPDATE_SID,
        .op_handle = operation->handle,
    };

    /* Sanitize the optional input */
    if ((input == NULL) && (input_length != 0)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length}
    };
    psa_outvec out_vec[] = {
        {.base = output, .len = output_size},
    };

    size_t in_len = IOVEC_LEN(in_vec);

    if (input == NULL) {
        in_len--;
    }
    status = psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL, in_vec, in_len,
                      out_vec, IOVEC_LEN(out_vec));

    *output_length = out_vec[0].len;
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_finish)(psa_aead_operation_t *operation,
                                              uint8_t *ciphertext,
                                              size_t ciphertext_size,
                                              size_t *ciphertext_length,
                                              uint8_t *tag,
                                              size_t tag_size,
                                              size_t *tag_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_FINISH_SID,
        .op_handle = operation->handle,
    };

    /* Sanitize the optional output */
    if ((ciphertext == NULL) && (ciphertext_size != 0)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
        {.base = tag, .len = tag_size},
        {.base = ciphertext, .len = ciphertext_size}
    };

    size_t out_len = IOVEC_LEN(out_vec);

    if (ciphertext == NULL || ciphertext_size == 0) {
        out_len--;
    }
    if ((out_len == 3) && (ciphertext_length == NULL)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    status = psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL,
                      in_vec, IOVEC_LEN(in_vec),
                      out_vec, out_len);

    if (out_len == 3) {
        *ciphertext_length = out_vec[2].len;
    } else {
        *ciphertext_length = 0;
    }

    *tag_length = out_vec[1].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_verify)(psa_aead_operation_t *operation,
                                              uint8_t *plaintext,
                                              size_t plaintext_size,
                                              size_t *plaintext_length,
                                              const uint8_t *tag,
                                              size_t tag_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_VERIFY_SID,
        .op_handle = operation->handle,
    };

    /* Sanitize the optional output */
    if ((plaintext == NULL) && (plaintext_size != 0)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = tag, .len = tag_length}
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
        {.base = plaintext, .len = plaintext_size}
    };

    size_t out_len = IOVEC_LEN(out_vec);

    if (plaintext == NULL || plaintext_size == 0) {
        out_len--;
    }
    if ((out_len == 2) && (plaintext_length == NULL)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    status = psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL,
                      in_vec, IOVEC_LEN(in_vec),
                      out_vec, out_len);

    if (out_len == 2) {
        *plaintext_length = out_vec[1].len;
    } else {
        *plaintext_length = 0;
    }
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_aead_abort)(psa_aead_operation_t *operation)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_AEAD_ABORT_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_sign_message)(psa_key_id_t key,
                                               psa_algorithm_t alg,
                                               const uint8_t *input,
                                               size_t input_length,
                                               uint8_t *signature,
                                               size_t signature_size,
                                               size_t *signature_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_ASYMMETRIC_SIGN_MESSAGE_SID,
        .key_id = key,
        .alg = alg,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
    };
    psa_outvec out_vec[] = {
        {.base = signature, .len = signature_size},
    };

    status = API_DISPATCH(in_vec, out_vec);

    *signature_length = out_vec[0].len;
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_verify_message)(psa_key_id_t key,
                                                 psa_algorithm_t alg,
                                                 const uint8_t *input,
                                                 size_t input_length,
                                                 const uint8_t *signature,
                                                 size_t signature_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_ASYMMETRIC_VERIFY_MESSAGE_SID,
        .key_id = key,
        .alg = alg
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
        {.base = signature, .len = signature_length}
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_sign_hash)(psa_key_id_t key,
                                            psa_algorithm_t alg,
                                            const uint8_t *hash,
                                            size_t hash_length,
                                            uint8_t *signature,
                                            size_t signature_size,
                                            size_t *signature_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_ASYMMETRIC_SIGN_HASH_SID,
        .key_id = key,
        .alg = alg,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = hash, .len = hash_length},
    };
    psa_outvec out_vec[] = {
        {.base = signature, .len = signature_size},
    };

    status = API_DISPATCH(in_vec, out_vec);

    *signature_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_verify_hash)(psa_key_id_t key,
                                              psa_algorithm_t alg,
                                              const uint8_t *hash,
                                              size_t hash_length,
                                              const uint8_t *signature,
                                              size_t signature_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_ASYMMETRIC_VERIFY_HASH_SID,
        .key_id = key,
        .alg = alg
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = hash, .len = hash_length},
        {.base = signature, .len = signature_length}
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_asymmetric_encrypt)(psa_key_id_t key,
                                                     psa_algorithm_t alg,
                                                     const uint8_t *input,
                                                     size_t input_length,
                                                     const uint8_t *salt,
                                                     size_t salt_length,
                                                     uint8_t *output,
                                                     size_t output_size,
                                                     size_t *output_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_ASYMMETRIC_ENCRYPT_SID,
        .key_id = key,
        .alg = alg
    };

    /* Sanitize the optional input */
    if ((salt == NULL) && (salt_length != 0)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
        {.base = salt, .len = salt_length}
    };

    psa_outvec out_vec[] = {
        {.base = output, .len = output_size},
    };

    size_t in_len = IOVEC_LEN(in_vec);

    if (salt == NULL) {
        in_len--;
    }
    status = psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL, in_vec, in_len,
                      out_vec, IOVEC_LEN(out_vec));

    *output_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_asymmetric_decrypt)(psa_key_id_t key,
                                                     psa_algorithm_t alg,
                                                     const uint8_t *input,
                                                     size_t input_length,
                                                     const uint8_t *salt,
                                                     size_t salt_length,
                                                     uint8_t *output,
                                                     size_t output_size,
                                                     size_t *output_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_ASYMMETRIC_DECRYPT_SID,
        .key_id = key,
        .alg = alg
    };

    /* Sanitize the optional input */
    if ((salt == NULL) && (salt_length != 0)) {
        return PSA_ERROR_INVALID_ARGUMENT;
    }

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
        {.base = salt, .len = salt_length}
    };

    psa_outvec out_vec[] = {
        {.base = output, .len = output_size},
    };

    size_t in_len = IOVEC_LEN(in_vec);

    if (salt == NULL) {
        in_len--;
    }
    status = psa_call(TFM_CRYPTO_HANDLE, PSA_IPC_CALL, in_vec, in_len,
                      out_vec, IOVEC_LEN(out_vec));

    *output_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_get_capacity)(
                                const psa_key_derivation_operation_t *operation,
                                size_t *capacity)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_GET_CAPACITY_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    psa_outvec out_vec[] = {
        {.base = capacity, .len = sizeof(size_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_output_bytes)(
                                      psa_key_derivation_operation_t *operation,
                                      uint8_t *output,
                                      size_t output_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_OUTPUT_BYTES_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    psa_outvec out_vec[] = {
        {.base = output, .len = output_length},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_input_key)(
                                      psa_key_derivation_operation_t *operation,
                                      psa_key_derivation_step_t step,
                                      psa_key_id_t key)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_INPUT_KEY_SID,
        .key_id = key,
        .step = step,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_abort)(psa_key_derivation_operation_t *operation)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_ABORT_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_key_agreement)(
                                      psa_key_derivation_operation_t *operation,
                                      psa_key_derivation_step_t step,
                                      psa_key_id_t private_key,
                                      const uint8_t *peer_key,
                                      size_t peer_key_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_KEY_AGREEMENT_SID,
        .key_id = private_key,
        .step = step,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = peer_key, .len = peer_key_length},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_generate_random)(uint8_t *output,
                                                  size_t output_size)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_GENERATE_RANDOM_SID,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    psa_outvec out_vec[] = {
        {.base = output, .len = output_size},
    };

    if (output_size == 0) {
        return PSA_SUCCESS;
    }

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_generate_key)(const psa_key_attributes_t *attributes,
                                               psa_key_id_t *key)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_GENERATE_KEY_SID,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = attributes, .len = sizeof(psa_key_attributes_t)},
    };

    psa_outvec out_vec[] = {
        {.base = key, .len = sizeof(psa_key_id_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_mac_compute)(psa_key_id_t key,
                                              psa_algorithm_t alg,
                                              const uint8_t *input,
                                              size_t input_length,
                                              uint8_t *mac,
                                              size_t mac_size,
                                              size_t *mac_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_MAC_COMPUTE_SID,
        .key_id = key,
        .alg = alg,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
    };
    psa_outvec out_vec[] = {
        {.base = mac, .len = mac_size},
    };

    status = API_DISPATCH(in_vec, out_vec);

    *mac_length = out_vec[0].len;
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_mac_verify)(psa_key_id_t key,
                                             psa_algorithm_t alg,
                                             const uint8_t *input,
                                             size_t input_length,
                                             const uint8_t *mac,
                                             const size_t mac_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_MAC_VERIFY_SID,
        .key_id = key,
        .alg = alg,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
        {.base = mac, .len = mac_length},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_cipher_encrypt)(psa_key_id_t key,
                                                 psa_algorithm_t alg,
                                                 const uint8_t *input,
                                                 size_t input_length,
                                                 uint8_t *output,
                                                 size_t output_size,
                                                 size_t *output_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CIPHER_ENCRYPT_SID,
        .key_id = key,
        .alg = alg,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
    };
    psa_outvec out_vec[] = {
        {.base = output, .len = output_size}
    };

    status = API_DISPATCH(in_vec, out_vec);

    *output_length = out_vec[0].len;
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_cipher_decrypt)(psa_key_id_t key,
                                                 psa_algorithm_t alg,
                                                 const uint8_t *input,
                                                 size_t input_length,
                                                 uint8_t *output,
                                                 size_t output_size,
                                                 size_t *output_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_CIPHER_DECRYPT_SID,
        .key_id = key,
        .alg = alg,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = input, .len = input_length},
    };
    psa_outvec out_vec[] = {
        {.base = output, .len = output_size}
    };

    status = API_DISPATCH(in_vec, out_vec);

    *output_length = out_vec[0].len;
    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_raw_key_agreement)(psa_algorithm_t alg,
                                                    psa_key_id_t private_key,
                                                    const uint8_t *peer_key,
                                                    size_t peer_key_length,
                                                    uint8_t *output,
                                                    size_t output_size,
                                                    size_t *output_length)
{
    psa_status_t status;
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_RAW_KEY_AGREEMENT_SID,
        .alg = alg,
        .key_id = private_key
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = peer_key, .len = peer_key_length},
    };

    psa_outvec out_vec[] = {
        {.base = output, .len = output_size},
    };

    status = API_DISPATCH(in_vec, out_vec);

    *output_length = out_vec[0].len;

    return status;
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_setup)(psa_key_derivation_operation_t *operation,
                                                       psa_algorithm_t alg)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_SETUP_SID,
        .alg = alg,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };
    psa_outvec out_vec[] = {
        {.base = &(operation->handle), .len = sizeof(uint32_t)},
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_set_capacity)(
                                      psa_key_derivation_operation_t *operation,
                                      size_t capacity)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_SET_CAPACITY_SID,
        .capacity = capacity,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_input_bytes)(
                                      psa_key_derivation_operation_t *operation,
                                      psa_key_derivation_step_t step,
                                      const uint8_t *data,
                                      size_t data_length)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_INPUT_BYTES_SID,
        .step = step,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = data, .len = data_length},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_output_key)(
                                      const psa_key_attributes_t *attributes,
                                      psa_key_derivation_operation_t *operation,
                                      psa_key_id_t *key)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_OUTPUT_KEY_SID,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
        {.base = attributes, .len = sizeof(psa_key_attributes_t)},
    };

    psa_outvec out_vec[] = {
        {.base = key, .len = sizeof(psa_key_id_t)}
    };

    return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_input_integer)(
                                      psa_key_derivation_operation_t *operation,
                                      psa_key_derivation_step_t step,
                                      uint64_t value)
{
    struct tfm_crypto_pack_iovec iov = {
        .function_id = TFM_CRYPTO_KEY_DERIVATION_INPUT_INTEGER_SID,
        .step = step,
        .value = value,
        .op_handle = operation->handle,
    };

    psa_invec in_vec[] = {
        {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
    };

    return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_verify_bytes)(
                                      psa_key_derivation_operation_t *operation,
                                      const uint8_t *expected_output,
                                      size_t output_length)
{
    /* To be implemented when the PSA backend supports it */
    return PSA_ERROR_NOT_SUPPORTED;
}

TFM_CRYPTO_API(psa_status_t, psa_key_derivation_verify_key)(
                                      psa_key_derivation_operation_t *operation,
                                      psa_key_id_t expected)
{
    /* To be implemented when the PSA backend supports it */
    return PSA_ERROR_NOT_SUPPORTED;
}

/* The implementation of the following helper function is marked
 * weak to allow for those integrations where this is directly
 * provided by the psa_crypto_client.c module of Mbed TLS
 */
__attribute__((weak))
TFM_CRYPTO_API(void, psa_reset_key_attributes)(
                                      psa_key_attributes_t *attributes)
{
    memset(attributes, 0, sizeof(*attributes));
}

TFM_CRYPTO_API(psa_status_t, psa_pake_setup)
(psa_pake_operation_t *operation, psa_key_id_t password_key,
 const psa_pake_cipher_suite_t *cipher_suite) {
  struct tfm_crypto_pack_iovec iov = {.function_id = TFM_CRYPTO_PAKE_SETUP_SID,
                                      .op_handle = operation->handle,
                                      .key_id = password_key};

  psa_invec in_vec[] = {
      {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
      {.base = cipher_suite, .len = sizeof(psa_pake_cipher_suite_t)},
  };

  psa_outvec out_vec[] = {
      {.base = &(operation->handle), .len = sizeof(uint32_t)},
  };

  return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_pake_set_role)
(psa_pake_operation_t *operation, psa_pake_role_t role) {
  struct tfm_crypto_pack_iovec iov = {
      .function_id = TFM_CRYPTO_PAKE_SET_ROLE_SID,
      .op_handle = operation->handle,
      .role = role,
  };

  psa_invec in_vec[] = {
      {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
  };

  return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_pake_set_user)
(psa_pake_operation_t *operation, const uint8_t *user_id, size_t user_id_len) {
  struct tfm_crypto_pack_iovec iov = {
      .function_id = TFM_CRYPTO_PAKE_SET_USER_SID,
      .op_handle = operation->handle,
  };

  psa_invec in_vec[] = {
      {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
      {.base = user_id, .len = user_id_len},
  };

  return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_pake_set_peer)
(psa_pake_operation_t *operation, const uint8_t *peer_id, size_t peer_id_len) {
  struct tfm_crypto_pack_iovec iov = {
      .function_id = TFM_CRYPTO_PAKE_SET_PEER_SID,
      .op_handle = operation->handle,
  };

  psa_invec in_vec[] = {
      {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
      {.base = peer_id, .len = peer_id_len},
  };

  return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_pake_set_context)
(psa_pake_operation_t *operation, const uint8_t *context, size_t context_len) {
  struct tfm_crypto_pack_iovec iov = {
      .function_id = TFM_CRYPTO_PAKE_SET_CONTEXT_SID,
      .op_handle = operation->handle,
  };

  psa_invec in_vec[] = {
      {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
      {.base = context, .len = context_len},
  };

  return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_pake_output)
(psa_pake_operation_t *operation, psa_pake_step_t step, uint8_t *output,
 size_t output_size, size_t *output_length) {
  psa_status_t status = PSA_ERROR_CORRUPTION_DETECTED;
  struct tfm_crypto_pack_iovec iov = {
      .function_id = TFM_CRYPTO_PAKE_OUTPUT_SID,
      .op_handle = operation->handle,
      .step = step,
  };

  psa_invec in_vec[] = {
      {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
  };

  psa_outvec out_vec[] = {{.base = output, .len = output_size}};

  status = API_DISPATCH(in_vec, out_vec);

  *output_length = out_vec[0].len;

  return status;
}

TFM_CRYPTO_API(psa_status_t, psa_pake_input)
(psa_pake_operation_t *operation, psa_pake_step_t step, const uint8_t *input,
 size_t input_length) {
  struct tfm_crypto_pack_iovec iov = {
      .function_id = TFM_CRYPTO_PAKE_INPUT_SID,
      .op_handle = operation->handle,
      .step = step,
  };

  psa_invec in_vec[] = {
      {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
      {.base = input, .len = input_length},
  };

  return API_DISPATCH_NO_OUTVEC(in_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_pake_get_shared_key)
(psa_pake_operation_t *operation, const psa_key_attributes_t *attributes,
 mbedtls_svc_key_id_t *key) {
  struct tfm_crypto_pack_iovec iov = {
      .function_id = TFM_CRYPTO_PAKE_GET_SHARED_KEY_SID,
      .op_handle = operation->handle,
  };

  psa_invec in_vec[] = {
      {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
      {.base = attributes, .len = sizeof(psa_key_attributes_t)},
  };

  psa_outvec out_vec[] = {
      {.base = &(operation->handle), .len = sizeof(uint32_t)},
      {.base = key, .len = sizeof(mbedtls_svc_key_id_t)}};

  return API_DISPATCH(in_vec, out_vec);
}

TFM_CRYPTO_API(psa_status_t, psa_pake_abort)(psa_pake_operation_t *operation) {
  struct tfm_crypto_pack_iovec iov = {
      .function_id = TFM_CRYPTO_PAKE_ABORT_SID,
      .op_handle = operation->handle,
  };

  psa_invec in_vec[] = {
      {.base = &iov, .len = sizeof(struct tfm_crypto_pack_iovec)},
  };
  psa_outvec out_vec[] = {
      {.base = &(operation->handle), .len = sizeof(uint32_t)},
  };

  return API_DISPATCH(in_vec, out_vec);
}
