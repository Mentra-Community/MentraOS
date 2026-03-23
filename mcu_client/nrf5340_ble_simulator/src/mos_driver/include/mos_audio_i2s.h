/*** 
 * @Author       : Cole
 * @Date         : 2025-08-15 17:43:14
 * @LastEditTime : 2026-01-30 09:59:21
 * @FilePath     : mos_audio_i2s.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */
#ifndef MOS_AUDIO_I2S_H_
#define MOS_AUDIO_I2S_H_

#include <zephyr/kernel.h>
#include <stdint.h>

/**
 * Calculation:
 * FREQ_VALUE = 2^16 * ((12 * f_out / 32M) - 4)
 * f_out == 12.288
 * 39845.888 = 2^16 * ((12 * 12.288 / 32M) - 4)
 * 39846 = 0x9BA6
 */
#define HFCLKAUDIO_12_288_MHZ 0x9BA6
#define HFCLKAUDIO_12_165_MHZ 0x8FD8
#define HFCLKAUDIO_12_411_MHZ 0xA774
/**
 * @brief Function to fill the I2S PCM data buffer.
 * This function is called to fill the I2S PCM data buffer with audio data.
 * It handles different configurations for stereo and mono audio playback.
 * @param i2c_pcm_data Pointer to the PCM data to be played.
 * @param i2c_pcm_size Size of the PCM data in samples.
 * @param i2s_pcm_ch Channel number for the I2S playback.
 *                   1 for left channel, 2 for right channel.
 */
void i2s_pcm_player(void *i2c_pcm_data, int16_t i2c_pcm_size, uint8_t i2s_pcm_ch);

/**
 * @brief Supply the buffers to be used in the next part of the I2S transfer
 *
 * @param tx_buf Pointer to the buffer with data to be sent
 * @param rx_buf Pointer to the buffer for received data
 */
void audio_i2s_set_next_buf(const uint8_t *tx_buf, uint32_t *rx_buf);

/**
 * @brief Start the continuous I2S transfer
 */
void audio_i2s_start(void);

/**
 * @brief Stop the continuous I2S transfer
 */
void audio_i2s_stop(void);

/**
 * @brief Check if I2S is initialized / 检查 I2S 是否已初始化
 * @return true if initialized, false otherwise / 如果已初始化返回 true，否则返回 false
 */
bool audio_i2s_is_initialized(void);
bool audio_i2s_is_started(void);

/**
 * @brief Initialize I2S module / 初始化 I2S 模块
 */
void audio_i2s_init(void);

/**
 * @brief Uninitialize I2S module and release hardware / 反初始化 I2S 模块并释放硬件
 */
void audio_i2s_uninit(void);

#endif /* MOS_AUDIO_I2S_H_ */
