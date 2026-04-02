/*
 * @Author       : Cole
 * @Date         : 2025-08-04 09:33:44
 * @LastEditTime : 2025-08-22 10:57:57
 * @FilePath     : task_lc3_codec.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */


#include <zephyr/logging/log.h>
#include <stdint.h>
#include "bal_os.h"
#include "bspal_audio_i2s.h"
#include "main.h"
#include "mos_pdm.h"
#include "sw_codec_lc3.h"
#include "task_ble_receive.h"
#include "task_lc3_codec.h"


#define LOG_MODULE_NAME TASK_LC3_CODEC
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

#define TASK_NAME "TASK_LC3_CODEC"

#define TASK_LC3_CODEC_THREAD_STACK_SIZE (4096)
#define TASK_LC3_CODEC_THREAD_PRIORITY   3
K_THREAD_STACK_DEFINE(task_lc3_codec_stack_area, TASK_LC3_CODEC_THREAD_STACK_SIZE);
static struct k_thread task_lc3_codec_thread_data;
k_tid_t                task_lc3_codec_thread_handle;
// This is used to specify the duration of each frame for the LC3 codec.
#define LC3_FRAME_SIZE_US 10000  // 帧长度，单位为微秒（us）。用于指定 LC3 编解码器每帧的持续时间;Frame length, measured in microseconds (us).
#define PCM_SAMPLE_RATE  16000  // PCM 采样率，单位为 Hz;PCM sampling rate, measured in Hz
#define PCM_BIT_DEPTH    16     // PCM 位深度，单位为 bit;PCM bit depth, measured in bits
#define LC3_BITRATE      32000  // LC3 编码器比特率，单位为 bps;LC3 encoder bitrate, measured in bits per second (bps)
#define LC3_NUM_CHANNELS 1      // 2      // LC3 编码器通道数，立体声为 2;LC3 encoder number of channels, stereo is 2
#define AUDIO_CH_L       0      // 左声道;left channel
#define AUDIO_CH_R       1      // 右声道;right channel
static uint16_t pcm_bytes_req_enc;

#define BLE_AUDIO_HDR 0xA0
uint8_t stream_id = 0;  // 0=MIC, 1=TTS
#define BLE_AUDIO_HDR_LEN 1
#define STREAM_ID_LEN     1

#define MAX_FRAMES_PER_PACKET 5  // 8 // 每个 BLE 包最多包含的 LC3 帧数;Maximum number of LC3 frames per BLE packet

// #define LC3_PCM_SAMPLES_PER_FRAME   (PCM_SAMPLE_RATE * LC3_FRAME_SIZE_US / 1000000) 
// #define PDM_PCM_REQ_BUFFER_SIZE     LC3_PCM_SAMPLES_PER_FRAME
#define LC3_FRAME_LEN       (LC3_BITRATE * LC3_FRAME_SIZE_US / 8 / 1000000)

int user_sw_codec_lc3_init(void)
{
    int ret;
    sw_codec_lc3_init(NULL, NULL, LC3_FRAME_SIZE_US);
    ret = sw_codec_lc3_enc_init(PCM_SAMPLE_RATE, PCM_BIT_DEPTH, LC3_FRAME_SIZE_US, LC3_BITRATE, LC3_NUM_CHANNELS,
                                &pcm_bytes_req_enc);
    if (ret < 0)
    {
        LOG_ERR("LC3 encoder initialization failed with error: %d", ret);
        return MOS_OS_ERROR;
    }
    else
    {
        LOG_INF("LC3 encoder pcm_bytes_req_enc:%d", pcm_bytes_req_enc);
    }
    ret = sw_codec_lc3_dec_init(PCM_SAMPLE_RATE, PCM_BIT_DEPTH, LC3_FRAME_SIZE_US, LC3_NUM_CHANNELS);
    if (ret < 0)
    {
        LOG_ERR("LC3 decoder initialization failed with error: %d", ret);
        return MOS_OS_ERROR;
    }
    return 0;
}
static inline uint8_t get_frames_per_packet(void)
{
    // 可用空间 = MTU - 包头（type+stream_id）;
    // Available space = MTU - packet header (type + stream_id)
    uint16_t payload_space = get_ble_payload_mtu() - BLE_AUDIO_HDR_LEN - STREAM_ID_LEN;
    uint8_t  frames        = payload_space / LC3_FRAME_LEN;
    if (frames > MAX_FRAMES_PER_PACKET)
    {
        frames = MAX_FRAMES_PER_PACKET;
    }
    return frames > 0 ? frames : 1;  // 最少1帧;minimum 1 frame
}
void send_lc3_multi_frame_packet(const uint8_t *frames, uint8_t num_frames, uint8_t stream_id)
{
    static uint8_t buf[517];
    uint16_t       offset = 0;
    memset(buf, 0, sizeof(buf));
    buf[offset++] = BLE_AUDIO_HDR;
    buf[offset++] = stream_id;

    // frames 是连续 num_frames * LC3_FRAME_LEN 的数据
    // frames is a continuous data of num_frames * LC3_FRAME_LEN
    memcpy(&buf[offset], frames, num_frames * LC3_FRAME_LEN);
    offset += num_frames * LC3_FRAME_LEN;
    // LOG_INF("Sending %d frames, total length: %d", num_frames, offset);
    // 实际最大长度不能超过当前协商MTU的payload空间
    // The actual maximum length cannot exceed the payload space of the
    // currently negotiated MTU
    uint16_t notify_len = offset;
    ble_send_data(buf, notify_len);
}

void task_lc3_codec_init(void *p1, void *p2, void *p3)
{
    int ret;
    // Initialize LC3 codec here
    // This is a placeholder function, actual implementation will depend on the
    // codec library used
    LOG_INF("LC3 codec initialized");
    int16_t pcm_req_buffer[PDM_PCM_REQ_BUFFER_SIZE]  = {0};
    int16_t pcm_req_buffer1[PDM_PCM_REQ_BUFFER_SIZE] = {0};
    // static uint8_t audio_encoded_l[PDM_PCM_REQ_BUFFER_SIZE];
    static uint16_t encoded_bytes_written_l;
    static uint16_t decoded_bytes_written_l;
    uint8_t         lc3_frame_buffer[MAX_FRAMES_PER_PACKET][LC3_FRAME_LEN];
    uint8_t         frame_count = 0;
    uint8_t         max_frames_per_packet;

    audio_i2s_init();
    audio_i2s_start();

    user_sw_codec_lc3_init();
    pdm_init();
    pdm_start();
    while (1)
    {
        if (!get_pdm_sample(pcm_req_buffer, PDM_PCM_REQ_BUFFER_SIZE))
        {
            ret = sw_codec_lc3_enc_run(pcm_req_buffer, 
                                        sizeof(pcm_req_buffer),
                                        LC3_USE_BITRATE_FROM_INIT, 
                                        AUDIO_CH_L,                
                                        LC3_FRAME_LEN, 
                                        lc3_frame_buffer[frame_count], 
                                        &encoded_bytes_written_l);
            if (ret < 0)
            {
                LOG_ERR("LC3 encoding failed with error: %d", ret);
            }
            else
            {
                // LOG_INF("LC3 encoding successful, bytes written: %d", encoded_bytes_written_l);
                // LOG_HEXDUMP_INF(lc3_frame_buffer[frame_count], encoded_bytes_written_l,"Hexdump");
                /************************************************** */
#if 0// test lc3 decode
                ret = sw_codec_lc3_dec_run(lc3_frame_buffer[frame_count], encoded_bytes_written_l,
                                           PDM_PCM_REQ_BUFFER_SIZE * 2, AUDIO_CH_L, pcm_req_buffer1,
                                           &decoded_bytes_written_l, false);
                if (ret < 0)
                {
                    LOG_ERR("LC3 decoding failed with error: %d", ret);
                }
                else
                {
                    LOG_INF("LC3 decoding successful, bytes written: %d", decoded_bytes_written_l);
                    {
                        i2s_pcm_player((void *)pcm_req_buffer1, decoded_bytes_written_l / 2, 0);
                    }
                }
#endif
            }
            frame_count++;
            max_frames_per_packet = get_frames_per_packet();
            if (frame_count >= max_frames_per_packet)
            {
                send_lc3_multi_frame_packet((uint8_t *)lc3_frame_buffer, frame_count, stream_id);
                frame_count = 0;
            }
        }
    }
}

void task_lc3_codec_thread(void)
{
    task_lc3_codec_thread_handle = k_thread_create(
                                    &task_lc3_codec_thread_data, 
                                    task_lc3_codec_stack_area, 
                                    K_THREAD_STACK_SIZEOF(task_lc3_codec_stack_area),
                                    task_lc3_codec_init, 
                                    NULL, NULL, NULL, 
                                    TASK_LC3_CODEC_THREAD_PRIORITY, 
                                    0, 
                                    MOS_OS_NO_WAIT);
    k_thread_name_set(task_lc3_codec_thread_handle, TASK_NAME);
}
