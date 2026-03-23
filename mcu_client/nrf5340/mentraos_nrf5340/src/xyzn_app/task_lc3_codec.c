/*
 * @Author       : XK
 * @Date         : 2025-07-18 09:46:01
 * @LastEditTime : 2025-07-29 11:51:30
 * @FilePath     : task_lc3_codec.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */

#include "bal_os.h"
#include "xyzn_pdm.h"
#include "bsp_log.h"
#include "task_lc3_codec.h"
#include "sw_codec_lc3.h"

#define TAG "TASK_LC3_CODEC"
#define TASK_NAME "TASK_LC3_CODEC"

#define TASK_LC3_CODEC_THREAD_STACK_SIZE (4096)
#define TASK_LC3_CODEC_THREAD_PRIORITY 5
K_THREAD_STACK_DEFINE(task_lc3_codec_stack_area, TASK_LC3_CODEC_THREAD_STACK_SIZE);
static struct k_thread task_lc3_codec_thread_data;
k_tid_t task_lc3_codec_thread_handle;

#define LC3_FRAME_SIZE_US 10000 // 帧长度，单位为微秒（us）。用于指定 LC3 编解码器每帧的持续时间
#define PCM_SAMPLE_RATE 16000   // PCM 采样率，单位为 Hz
#define PCM_BIT_DEPTH 16        // PCM 位深度，单位为 bit
#define LC3_BITRATE 32000       // 96000        // LC3 编码器比特率，单位为 bps
#define LC3_NUM_CHANNELS 1      // 2            // LC3 编码器通道数，立体声为 2
#define AUDIO_CH_L 0            // 左声道
#define AUDIO_CH_R 1            // 右声道
static uint16_t pcm_bytes_req_enc;
// 初始化LC3编解码器
int user_sw_codec_lc3_init(void)
{
    int ret;
    // 初始化LC3编解码器
    sw_codec_lc3_init(NULL, NULL, LC3_FRAME_SIZE_US);
    // 初始化LC3编码器
    ret = sw_codec_lc3_enc_init(PCM_SAMPLE_RATE,
                                PCM_BIT_DEPTH,
                                LC3_FRAME_SIZE_US,
                                LC3_BITRATE,
                                LC3_NUM_CHANNELS,
                                &pcm_bytes_req_enc);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "LC3 encoder initialization failed with error: %d", ret);
        return XYZN_OS_ERROR;
    }

    // // 初始化LC3解码器
    // ret = sw_codec_lc3_dec_init(PCM_SAMPLE_RATE,
    //                             PCM_BIT_DEPTH,
    //                             LC3_FRAME_SIZE_US,
    //                             LC3_NUM_CHANNELS);
    // if (ret < 0)
    // {
    //     BSP_LOGE(TAG, "LC3 decoder initialization failed with error: %d", ret);
    //     return XYZN_OS_ERROR;
    // }

    return 0;
}

void task_lc3_codec_init(void *p1, void *p2, void *p3)
{
    int ret;
    // Initialize LC3 codec here
    // This is a placeholder function, actual implementation will depend on the codec library used
    BSP_LOGI(TAG, "LC3 codec initialized");
    int16_t pcm_req_buffer[PDM_PCM_REQ_BUFFER_SIZE] = {0};
    static uint8_t audio_encoded_l[PDM_PCM_REQ_BUFFER_SIZE];
    static uint16_t encoded_bytes_written_l;
    user_sw_codec_lc3_init();

    pdm_init();
    // pdm_start();
    while (1)
    {
        if (!get_pdm_sample(pcm_req_buffer, PDM_PCM_REQ_BUFFER_SIZE))
        {
            // Process PCM data here
            // For example, encode it using LC3 codec
            ret = sw_codec_lc3_enc_run(pcm_req_buffer,
                                       sizeof(pcm_req_buffer),
                                       LC3_USE_BITRATE_FROM_INIT,
                                       AUDIO_CH_L,
                                       sizeof(audio_encoded_l),
                                       audio_encoded_l,
                                       &encoded_bytes_written_l);
            if (ret < 0)
            {
                BSP_LOGE(TAG, "LC3 encoding failed with error: %d", ret);
            }
            else
            {
                BSP_LOGI(TAG, "LC3 encoding successful, bytes written: %d", encoded_bytes_written_l);
                BSP_LOG_BUFFER_HEX(TAG, audio_encoded_l, encoded_bytes_written_l);
                // Here you can send the encoded data over BLE or store it
            }
        }
        xyzn_os_delay_ms(10); // Adjust delay as needed
    }
}

void task_lc3_codec_thread(void)
{
    task_lc3_codec_thread_handle = k_thread_create(&task_lc3_codec_thread_data,
                                                   task_lc3_codec_stack_area,
                                                   K_THREAD_STACK_SIZEOF(task_lc3_codec_stack_area),
                                                   task_lc3_codec_init,
                                                   NULL,
                                                   NULL,
                                                   NULL,
                                                   TASK_LC3_CODEC_THREAD_PRIORITY,
                                                   0,
                                                   XYZN_OS_NO_WAIT);
    k_thread_name_set(task_lc3_codec_thread_handle, TASK_NAME);
}
