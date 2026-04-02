/*
 * Copyright (c) 2019-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#include <stdbool.h>
#include "tfm_platform_api.h"
#include "psa/client.h"
#include "psa_manifest/sid.h"

enum tfm_platform_err_t tfm_platform_system_reset(void)
{
    psa_status_t status = PSA_ERROR_CONNECTION_REFUSED;

    status = psa_call(TFM_PLATFORM_SERVICE_HANDLE,
                      TFM_PLATFORM_API_ID_SYSTEM_RESET,
                      NULL, 0, NULL, 0);

    if (status < PSA_SUCCESS) {
        return TFM_PLATFORM_ERR_SYSTEM_ERROR;
    } else {
        return (enum tfm_platform_err_t)status;
    }

}

enum tfm_platform_err_t
tfm_platform_ioctl(tfm_platform_ioctl_req_t request,
                   psa_invec *input, psa_outvec *output)
{
    tfm_platform_ioctl_req_t req = request;
    struct psa_invec in_vec[2] = { {0} };
    size_t inlen, outlen;
    psa_status_t status = PSA_ERROR_CONNECTION_REFUSED;

    in_vec[0].base = &req;
    in_vec[0].len = sizeof(req);
    if (input != NULL) {
        in_vec[1].base = input->base;
        in_vec[1].len = input->len;
        inlen = 2;
    } else {
        inlen = 1;
    }

    if (output != NULL) {
        outlen = 1;
    } else {
        outlen = 0;
    }

    status = psa_call(TFM_PLATFORM_SERVICE_HANDLE,
                      TFM_PLATFORM_API_ID_IOCTL,
                      in_vec, inlen,
                      output, outlen);

    if (status < PSA_SUCCESS) {
        return TFM_PLATFORM_ERR_SYSTEM_ERROR;
    } else {
        return (enum tfm_platform_err_t)status;
    }
}

enum tfm_platform_err_t
tfm_platform_nv_counter_increment(uint32_t counter_id)
{
    psa_status_t status = PSA_ERROR_CONNECTION_REFUSED;
    struct psa_invec in_vec[1];

    in_vec[0].base = &counter_id;
    in_vec[0].len = sizeof(counter_id);

    status = psa_call(TFM_PLATFORM_SERVICE_HANDLE,
                      TFM_PLATFORM_API_ID_NV_INCREMENT,
                      in_vec, 1, (psa_outvec *)NULL, 0);

    if (status < PSA_SUCCESS) {
        return TFM_PLATFORM_ERR_SYSTEM_ERROR;
    } else {
        return (enum tfm_platform_err_t)status;
    }
}

enum tfm_platform_err_t
tfm_platform_nv_counter_read(uint32_t counter_id,
                             uint32_t size, uint8_t *val)
{
    psa_status_t status = PSA_ERROR_CONNECTION_REFUSED;
    struct psa_invec in_vec[1];
    struct psa_outvec out_vec[1];

    in_vec[0].base = &counter_id;
    in_vec[0].len = sizeof(counter_id);

    out_vec[0].base = val;
    out_vec[0].len = size;

    status = psa_call(TFM_PLATFORM_SERVICE_HANDLE,
                      TFM_PLATFORM_API_ID_NV_READ,
                      in_vec, 1, out_vec, 1);

    if (status < PSA_SUCCESS) {
        return TFM_PLATFORM_ERR_SYSTEM_ERROR;
    } else {
        return (enum tfm_platform_err_t)status;
    }
}
