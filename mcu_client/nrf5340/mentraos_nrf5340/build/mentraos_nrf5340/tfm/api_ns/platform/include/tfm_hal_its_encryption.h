/*
 * Copyright (c) 2020, Cypress Semiconductor Corporation. All rights reserved.
 * Copyright (c) 2020-2021, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_HAL_ITS_ENCRYPTION_H__
#define __TFM_HAL_ITS_ENCRYPTION_H__

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif


/**
 * \brief Struct containing information required from the platform to perform
 *        encryption/decryption of ITS files.
 */
struct tfm_hal_its_auth_crypt_ctx {
    uint8_t *deriv_label;    /* The derivation label for AEAD */
    size_t deriv_label_size; /* Size of the deriv_label in bytes */
    uint8_t *aad;            /* The additional authenticated data for AEAD */
    size_t add_size;         /* Size of the add in bytes */
    uint8_t *nonce;          /* The nonce for AEAD */
    size_t nonce_size;       /* Size of the nonce in bytes */
};

/**
 * \brief Generate an encryption nonce
 *
 * \details The nonce has to be unique for every encryption using the same key,
 *          even across resets.
 * \param [out] nonce           Pointer to the nonce
 * \param [in]  nonce_size      Size of the nonce in bytes
 *
 * \retval TFM_HAL_SUCCESS             The operation completed successfully
 * \retval TFM_HAL_ERROR_INVALID_INPUT Invalid argument
 * \retval TFM_HAL_ERROR_GENERIC       Failed to fill the nonce seed because of
 *                                     an internal error
 */
enum tfm_hal_status_t tfm_hal_its_aead_generate_nonce(uint8_t *nonce,
                                                      const size_t nonce_size);

/**
 * \brief Perform authenticated encryption.
 *
 * \details Perform the the AEAD encryption.
 *          It will start with deriving a key based long-term key-derivation
 *          key and the provided derivation label.
 *          This derived key will then be used to perform the AEAD operation.
 *          Therefore the following members of the ctx struct must be set:
 *          nonce
 *          nonce_size
 *          deriv_label
 *          deriv_label_size
 *          If additional data should be authenticated also
 *          aad
 *          aad_size
 *          must be set.
 *
 * \param [in]  ctx               AEAD context for ITS object
 * \param [in]  plaintext         Pointer to the plaintext
 * \param [in]  plaintext_size    Size of the plaintext in bytes
 * \param [out] ciphertext        Pointer to the ciphertext
 * \param [in]  ciphertext_size   Size of the ciphertext in bytes
 * \param [out] tag               Authentication tag
 * \param [in]  tag_size          Authentication tag size in bytes
 *
 * \retval TFM_HAL_SUCCESS             The operation completed successfully
 * \retval TFM_HAL_ERROR_INVALID_INPUT Invalid argument
 * \retval TFM_HAL_ERROR_GENERIC       Failed to encrypt
 */
enum tfm_hal_status_t tfm_hal_its_aead_encrypt(
                                         struct tfm_hal_its_auth_crypt_ctx *ctx,
                                         const uint8_t *plaintext,
                                         const size_t plaintext_size,
                                         uint8_t *ciphertext,
                                         const size_t ciphertext_size,
                                         uint8_t *tag,
                                         const size_t tag_size);

/**
 * \brief Perform authenticated decryption.
 *
 * \details To perform the the AEAD decryption, the following members of the
 *          ctx struct must be set:
 *          nonce
 *          nonce_size
 *          deriv_label
 *          deriv_label_size
 *          If additional data should be authenticated also
 *          aad
 *          aad_size
 *          must be set.
 *
 *
 * \param [in]  ctx               AEAD context for ITS object
 * \param [in]  ciphertext        Pointer to the ciphertext
 * \param [in]  ciphertext_size   Size of the ciphertext in bytes
 * \param [in]  tag               Authentication tag
 * \param [in]  tag_size          Authentication tag size in bytes
 * \param [out] plaintext         Pointer to the plaintext
 * \param [in]  plaintext_size    Size of the plaintext in bytes
 *
 * \retval TFM_HAL_SUCCESS             The operation completed successfully
 * \retval TFM_HAL_ERROR_INVALID_INPUT Invalid argument
 * \retval TFM_HAL_ERROR_GENERIC       Failed to decrypt
 */
enum tfm_hal_status_t tfm_hal_its_aead_decrypt(
                                         struct tfm_hal_its_auth_crypt_ctx *ctx,
                                         const uint8_t *ciphertext,
                                         const size_t ciphertext_size,
                                         uint8_t *tag,
                                         const size_t tag_size,
                                         uint8_t *plaintext,
                                         const size_t plaintext_size);


#ifdef __cplusplus
}
#endif

#endif /* __TFM_HAL_ITS_ENCRYPTION_H__ */
