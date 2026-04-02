/*** 
 * @Author       : Cole
 * @Date         : 2025-07-31 11:52:00
 * @LastEditTime : 2025-07-31 16:44:22
 * @FilePath     : mos_pdm.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef _MOS_PDM_H_
#define _MOS_PDM_H_

#define CONFIG_USER_ENCODE_OPUS 1
#define CONFIG_NRFX_PDM 		1

//=========================================================================================================
// 16KHz 16bit
// 每ms采样次数 = 16000/1000=16次
// 每ms采样数据 = (16000/1000)*2byte = 32byte

#ifdef CONFIG_NRFX_PDM

// PDM接口采样数据PCM缓存
#ifdef CONFIG_USER_ENCODE_OPUS
#define PDM_PCM_REQ_BUFFER_SIZE 160 // 16K 16bit 10ms = 160sample(320byte) 20ms = 320sanple(640byte)
#elif CONFIG_USER_ENCODE_SBC
#define PDM_PCM_REQ_BUFFER_SIZE 128 // 16K 16bit 8ms = 128sample(256byte) 16ms = 256sanple(512byte)
#elif CONFIG_USER_ENCODE_LC3
#define PDM_PCM_REQ_BUFFER_SIZE 128
#endif
#endif

void pdm_init(void);

void pdm_start(void);

void pdm_stop(void);

uint32_t get_pdm_sample(int16_t *pdm_pcm_data, uint32_t pdm_pcm_szie);

#endif // _MOS_PDM_H_