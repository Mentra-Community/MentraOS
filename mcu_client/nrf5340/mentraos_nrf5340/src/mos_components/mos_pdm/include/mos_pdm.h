/***
 * @Author       : Cole
 * @Date         : 2025-08-18 19:27:06
 * @LastEditTime : 2025-08-19 14:01:57
 * @FilePath     : mos_pdm.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _MOS_PDM_H_
#define _MOS_PDM_H_
#include <stdint.h>

#define CONFIG_USER_ENCODE_LC3 1
#define CONFIG_NRFX_PDM        1

#ifdef CONFIG_NRFX_PDM

/* PDM接口采样数据PCM缓存;PDM interface PCM buffer */
#ifdef CONFIG_USER_ENCODE_LC3
#define PDM_PCM_REQ_BUFFER_SIZE 160  // 16K 16bit 10ms = 160sample(320byte) 20ms = 320sanple(640byte)
#endif

#endif

void pdm_init(void);

void pdm_start(void);

void pdm_stop(void);

uint32_t get_pdm_sample(int16_t *pdm_pcm_data, uint32_t pdm_pcm_szie);

#endif  // _MOS_PDM_H_