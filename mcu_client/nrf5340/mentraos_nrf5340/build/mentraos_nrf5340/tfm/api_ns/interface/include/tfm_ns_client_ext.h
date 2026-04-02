/*
 * Copyright (c) 2021, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_NS_CLIENT_EXT_H__
#define __TFM_NS_CLIENT_EXT_H__

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

#define TFM_NS_CLIENT_INVALID_TOKEN         0xFFFFFFFF

/* TF-M NSID Error code */
#define TFM_NS_CLIENT_ERR_SUCCESS           0x0
#define TFM_NS_CLIENT_ERR_INVALID_TOKEN     0x1
#define TFM_NS_CLIENT_ERR_INVALID_NSID      0x2
#define TFM_NS_CLIENT_ERR_INVALID_ACCESS    0x3

/**
 * \brief Initialize the non-secure client extension
 *
 * \details This function should be called before any other non-secure client
 *          APIs. It gives NSPE the opportunity to initialize the non-secure
 *          client extension in TF-M. Also, NSPE can get the number of allocated
 *          non-secure client context slots in the return value. That is useful
 *          if NSPE wants to decide the group (context) assignment at runtime.
 *
 * \param[in] ctx_requested The number of non-secure context requested from the
 *            NS entity. If request maximum available context, then set it to 0.
 *
 * \return Returns the number of non-secure context allocated to the NS entity.
 *         The allocated context number <= maximum supported context number.
 *         If the initialization is failed, then 0 is returned.
 */
uint32_t tfm_nsce_init(uint32_t ctx_requested);

/**
 * \brief Acquire the context for a non-secure client
 *
 * \details This function should be called before a non-secure client calling
 *          the PSA API into TF-M. It is to request the allocation of the
 *          context for the upcoming service call from that non-secure client.
 *          The non-secure clients in one group share the same context.
 *          The thread ID is used to identify the different non-secure clients.
 *
 * \param[in] group_id The group ID of the non-secure client
 * \param[in] thread_id The thread ID of the non-secure client
 *
 * \return Returns the token of the allocated context. 0xFFFFFFFF means the
 *         allocation failed and the token is invalid.
 */
uint32_t tfm_nsce_acquire_ctx(uint8_t group_id, uint8_t thread_id);

/**
 * \brief Release the context for the non-secure client
 *
 * \details This function should be called when a non-secure client is going to
 *          be terminated or will not call TF-M secure services in the future.
 *          It is to release the context allocated for the calling non-secure
 *          client. If the calling non-secure client is the only thread in the
 *          group, then the context will be deallocated. Otherwise, the context
 *          will still be taken for the other threads in the group.
 *
 * \param[in] token The token returned by tfm_nsce_acquire_ctx
 *
 * \return Returns the error code.
 */
uint32_t tfm_nsce_release_ctx(uint32_t token);

/**
 * \brief Load the context for the non-secure client
 *
 * \details This function should be called when a non-secure client is going to
 *          be scheduled in at the non-secure side.
 *          The caller is usually the scheduler of the RTOS.
 *          The non-secure client ID is managed by the non-secure world and
 *          passed to TF-M as the input parameter of TF-M.
 *
 * \param[in] token The token returned by tfm_nsce_acquire_ctx
 * \param[in] nsid The non-secure client ID for this client
 *
 * \return Returns the error code.
 */
uint32_t tfm_nsce_load_ctx(uint32_t token, int32_t nsid);

/**
 * \brief Save the context for the non-secure client
 *
 * \details This function should be called when a non-secure client is going to
 *          be scheduled out at the non-secure side.
 *          The caller is usually the scheduler of the RTOS.
 *
 * \param[in] token The token returned by tfm_nsce_acquire_ctx
 *
 * \return Returns the error code.
 */
uint32_t tfm_nsce_save_ctx(uint32_t token);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_NS_CLIENT_EXT_H__ */
