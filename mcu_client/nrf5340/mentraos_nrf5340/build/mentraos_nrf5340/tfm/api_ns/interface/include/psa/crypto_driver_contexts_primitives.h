/*
 *  Declaration of context structures for use with the PSA driver wrapper
 *  interface. This file contains the context structures for 'primitive'
 *  operations, i.e. those operations which do not rely on other contexts.
 *
 * \note This file may not be included directly. Applications must
 * include psa/crypto.h.
 *
 * \note This header and its content are not part of the Mbed TLS API and
 * applications must not depend on it. Its main purpose is to define the
 * multi-part state objects of the PSA drivers included in the cryptographic
 * library. The definitions of these objects are then used by crypto_struct.h
 * to define the implementation-defined types of PSA multi-part state objects.
 */
/*  Copyright The Mbed TLS Contributors
 *  SPDX-License-Identifier: Apache-2.0 OR GPL-2.0-or-later
 */

/*
 * NOTICE: This file has been modified by Oberon microsystems AG.
 */

#ifndef PSA_CRYPTO_DRIVER_CONTEXTS_PRIMITIVES_H
#define PSA_CRYPTO_DRIVER_CONTEXTS_PRIMITIVES_H

#include "psa/crypto_driver_common.h"

/* Include the context structure definitions for enabled drivers. */

#ifdef PSA_NEED_OBERON_HASH_DRIVER
#include "oberon_hash.h"
#endif
#ifdef PSA_NEED_OBERON_CIPHER_DRIVER
#include "oberon_cipher.h"
#endif
#ifdef PSA_NEED_HARDWARE_DEMO_DRIVER
#include "demo_hardware.h"
#endif
#ifdef PSA_NEED_OPAQUE_DEMO_DRIVER
#include "demo_opaque.h"
#endif

/* Define the context to be used for an operation that is executed through the
 * PSA Driver wrapper layer as the union of all possible driver's contexts.
 *
 * The union members are the driver's context structures, and the member names
 * are formatted as `'drivername'_ctx`. This allows for procedural generation
 * of both this file and the content of psa_crypto_driver_wrappers.c */

typedef union {
    unsigned dummy; /* Make sure this union is always non-empty */
#ifdef PSA_NEED_HARDWARE_DEMO_DRIVER
    demo_hardware_hash_operation_t oberon_hw_hash_ctx;
#endif
#ifdef PSA_NEED_OBERON_HASH_DRIVER
    oberon_hash_operation_t oberon_hash_ctx;
#endif
} psa_driver_hash_context_t;

typedef union {
    unsigned dummy; /* Make sure this union is always non-empty */
#ifdef PSA_NEED_HARDWARE_DEMO_DRIVER
    demo_hardware_cipher_operation_t oberon_hw_cipher_ctx;
#endif
#ifdef PSA_NEED_OBERON_CIPHER_DRIVER
    oberon_cipher_operation_t oberon_cipher_ctx;
#endif
#ifdef PSA_NEED_OPAQUE_DEMO_DRIVER
    oberon_opaque_cipher_operation_t opaque_cipher_ctx;
#endif
} psa_driver_cipher_context_t;

#endif /* PSA_CRYPTO_DRIVER_CONTEXTS_PRIMITIVES_H */
