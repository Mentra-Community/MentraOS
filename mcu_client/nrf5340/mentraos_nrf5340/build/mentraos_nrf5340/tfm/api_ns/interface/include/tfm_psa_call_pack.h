/*
 * Copyright (c) 2021-2022, Arm Limited. All rights reserved.
 *
 * SPDX-License-Identifier: BSD-3-Clause
 *
 */

#ifndef __TFM_PSA_CALL_PACK_H__
#define __TFM_PSA_CALL_PACK_H__

#include "psa/client.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 *  31           30-28   27    26-24  23-20   19     18-16   15-0
 * +------------+-----+------+-------+-----+-------+-------+------+
 * | NS vector  |     | NS   | invec |     | NS    | outvec| type |
 * | descriptor | Res | invec| number| Res | outvec| number|      |
 * +------------+-----+------+-------+-----+-------+-------+------+
 *
 * Res: Reserved.
 */
#define TYPE_MASK            0xFFFFUL

#define IN_LEN_OFFSET        24
#define IN_LEN_MASK          (0x7UL << IN_LEN_OFFSET)

#define OUT_LEN_OFFSET       16
#define OUT_LEN_MASK         (0x7UL << OUT_LEN_OFFSET)

/*
 * NS_VEC_DESC_BIT is referenced by inline assembly, which does not
 * support composited bit operations. So NS_VEC_DESC_BIT must be
 * defined as a number.
 */
#define NS_VEC_DESC_BIT      0x80000000UL

#define NS_INVEC_OFFSET      27
#define NS_INVEC_BIT         (1UL << NS_INVEC_OFFSET)
#define NS_OUTVEC_OFFSET     19
#define NS_OUTVEC_BIT        (1UL << NS_OUTVEC_OFFSET)

#define PARAM_PACK(type, in_len, out_len)                            \
          ((((uint32_t)(type)) & TYPE_MASK)                        | \
           ((((uint32_t)(in_len)) << IN_LEN_OFFSET) & IN_LEN_MASK) | \
           ((((uint32_t)(out_len)) << OUT_LEN_OFFSET) & OUT_LEN_MASK))

#define PARAM_UNPACK_TYPE(ctrl_param)                                \
          ((int32_t)(int16_t)((ctrl_param) & TYPE_MASK))

#define PARAM_UNPACK_IN_LEN(ctrl_param)                              \
          ((size_t)(((ctrl_param) & IN_LEN_MASK) >> IN_LEN_OFFSET))

#define PARAM_UNPACK_OUT_LEN(ctrl_param)                             \
          ((size_t)(((ctrl_param) & OUT_LEN_MASK) >> OUT_LEN_OFFSET))

#define PARAM_SET_NS_VEC(ctrl_param)    ((ctrl_param) | NS_VEC_DESC_BIT)
#define PARAM_IS_NS_VEC(ctrl_param)     ((ctrl_param) & NS_VEC_DESC_BIT)

#define PARAM_SET_NS_INVEC(ctrl_param)  ((ctrl_param) | NS_INVEC_BIT)
#define PARAM_IS_NS_INVEC(ctrl_param)   ((ctrl_param) & NS_INVEC_BIT)
#define PARAM_SET_NS_OUTVEC(ctrl_param) ((ctrl_param) | NS_OUTVEC_BIT)
#define PARAM_IS_NS_OUTVEC(ctrl_param)  ((ctrl_param) & NS_OUTVEC_BIT)

#define PARAM_HAS_IOVEC(ctrl_param)                                  \
          ((ctrl_param) != (uint32_t)PARAM_UNPACK_TYPE(ctrl_param))

psa_status_t tfm_psa_call_pack(psa_handle_t handle,
                               uint32_t ctrl_param,
                               const psa_invec *in_vec,
                               psa_outvec *out_vec);

#ifdef __cplusplus
}
#endif

#endif /* __TFM_PSA_CALL_PACK_H__ */
