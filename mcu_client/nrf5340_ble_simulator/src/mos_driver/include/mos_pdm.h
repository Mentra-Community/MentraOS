/*** 
 * @Author       : Cole
 * @Date         : 2025-07-31 11:52:00
 * @LastEditTime : 2026-01-30 09:58:09
 * @FilePath     : mos_pdm.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */


#ifndef MOS_PDM_H_
#define MOS_PDM_H_

#include <stdint.h>
#include <stdbool.h>

#define CONFIG_USER_ENCODE_LC3 1
#define CONFIG_NRFX_PDM        1

#ifdef CONFIG_NRFX_PDM

/* PDM接口采样数据PCM缓存;PDM interface PCM buffer */
#ifdef CONFIG_USER_ENCODE_LC3
#define PDM_PCM_REQ_BUFFER_SIZE 160  // 16K 16bit 10ms = 160sample(320byte) per channel
#define PDM_AUDIO_CHANNELS      2
#define PDM_PCM_FRAME_SAMPLES   (PDM_PCM_REQ_BUFFER_SIZE * PDM_AUDIO_CHANNELS)
#define PDM_PCM_FRAME_BYTES     (PDM_PCM_FRAME_SAMPLES * sizeof(int16_t))
#endif

#endif


typedef enum
{
    PDM_CHANNEL_LEFT = 0,
    PDM_CHANNEL_RIGHT = 1,
    PDM_CHANNEL_STEREO_MIXED = 2,
} pdm_channel_t;

int pdm_set_channel(pdm_channel_t channel);

pdm_channel_t pdm_get_channel(void);

bool pdm_is_running(void);

bool pdm_is_initialized(void);

uint32_t pdm_get_frame_samples(void);

uint32_t pdm_get_frame_bytes(void);

void pdm_init(void);

void pdm_start(void);

void pdm_stop(void);

uint32_t get_pdm_sample(int16_t *pdm_pcm_data, uint32_t pdm_pcm_szie);

#endif // MOS_PDM_H_