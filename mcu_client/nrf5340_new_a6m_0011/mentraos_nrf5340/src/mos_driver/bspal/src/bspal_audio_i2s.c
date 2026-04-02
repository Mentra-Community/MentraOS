/*
 * @Author       : Cole
 * @Date         : 2025-08-05 18:00:04
 * @LastEditTime : 2025-08-19 19:46:41
 * @FilePath     : bspal_audio_i2s.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */



#include <nrfx_clock.h>
#include <nrfx_i2s.h>
#include <zephyr/device.h>
#include <zephyr/drivers/pinctrl.h>
#include <zephyr/kernel.h>
// #include "audio_sync_timer.h"
#include <zephyr/logging/log.h>
#include "bspal_audio_i2s.h"
#include "mos_pdm.h"

#define LOG_MODULE_NAME BSPAL_I2S
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

#define I2S_NL DT_NODELABEL(i2s0)


enum audio_i2s_state
{
    AUDIO_I2S_STATE_UNINIT,
    AUDIO_I2S_STATE_IDLE,
    AUDIO_I2S_STATE_STARTED,
};

static enum audio_i2s_state state = AUDIO_I2S_STATE_UNINIT;

PINCTRL_DT_DEFINE(I2S_NL);  // I2S0 pins

static nrfx_i2s_t i2s_inst = NRFX_I2S_INSTANCE(0);
static uint32_t   i2s_rx_req_buffer[2][PDM_PCM_REQ_BUFFER_SIZE];
static uint32_t   i2s_tx_req_buffer[2][PDM_PCM_REQ_BUFFER_SIZE];

static nrfx_i2s_config_t cfg = {
    /* Pins are configured by pinctrl. */
    .skip_gpio_cfg = true,
    .skip_psel_cfg = true,
    .irq_priority  = DT_IRQ(I2S_NL, priority),
    .mode          = NRF_I2S_MODE_MASTER,
    .format        = NRF_I2S_FORMAT_I2S,
    .alignment     = NRF_I2S_ALIGN_LEFT,
    .sample_width  = NRF_I2S_SWIDTH_16BIT,
    .channels      = NRF_I2S_CHANNELS_STEREO,
    .enable_bypass = false,

    .clksrc    = NRF_I2S_CLKSRC_ACLK,  // 用音频时钟；Use the audio clock
    .mck_setup = NRF_I2S_MCK_32MDIV8,  // 对 ACLK 等价于 ACLK/8 = 12.288M/8 = 1.536 MHz；The ACLK is equivalent to
                                       // ACLK/8 = 12.288M/8 = 1.536 MHz
    .ratio = NRF_I2S_RATIO_96X,        // LRCK = 1.536M / 96 = 16 kHz 精准对齐；LRCK = 1.536M / 96 = 16 kHz - Precisely
                                       // aligned

};

nrfx_i2s_buffers_t const i2s_req_buffer[2] = {
    {
        .p_rx_buffer = i2s_rx_req_buffer[0],
        .p_tx_buffer = i2s_tx_req_buffer[0],
        .buffer_size = PDM_PCM_REQ_BUFFER_SIZE,
    },

    {
        .p_rx_buffer = i2s_rx_req_buffer[1],
        .p_tx_buffer = i2s_tx_req_buffer[1],
        .buffer_size = PDM_PCM_REQ_BUFFER_SIZE,
    },
};
static uint32_t *volatile mp_block_to_fill = NULL;
static void i2s_buffer_req_evt_handle(nrfx_i2s_buffers_t const *p_released, uint32_t status)
{
    uint32_t err_code;
    if (!(status & NRFX_I2S_STATUS_NEXT_BUFFERS_NEEDED))  // If no next buffers
    {
        LOG_ERR("i2s_buffer_req_evt_handle: No next buffers needed, status = %lu", status);
        return;
    }
    // p_released->p_rx_buffer为已经播放完成的缓冲区，可以释放掉或用来填充下一帧播放数据;
    // p_released->p_rx_buffer is the buffer that has finished playing, can be released or used to fill the next frame
    // of playback data
    if (p_released->p_rx_buffer == NULL)
    {
        err_code         = nrfx_i2s_next_buffers_set(&i2s_inst, &i2s_req_buffer[1]);
        mp_block_to_fill = i2s_tx_req_buffer[1];
        // printk("i2s p_released->p_rx_buffer = %lld\r\n", k_uptime_get() );
    }
    else
    {
        err_code         = nrfx_i2s_next_buffers_set(&i2s_inst, p_released);
        mp_block_to_fill = (uint32_t *)p_released->p_tx_buffer;
        // printk("i2s next buffers needed = %lld\r\n", k_uptime_get() );
    }
}

void audio_i2s_start(void)
{
    __ASSERT_NO_MSG(state == AUDIO_I2S_STATE_IDLE);
    nrfx_err_t ret;
    /* Buffer size in 32-bit words */
    ret = nrfx_i2s_start(&i2s_inst, &i2s_req_buffer[0], 0);
    __ASSERT_NO_MSG(ret == NRFX_SUCCESS);

    state = AUDIO_I2S_STATE_STARTED;
}

void audio_i2s_stop(void)
{
    __ASSERT_NO_MSG(state == AUDIO_I2S_STATE_STARTED);

    nrfx_i2s_stop(&i2s_inst);

    state = AUDIO_I2S_STATE_IDLE;
}

void audio_i2s_init(void)
{
    __ASSERT_NO_MSG(state == AUDIO_I2S_STATE_UNINIT);

    nrfx_err_t ret;

    nrfx_clock_hfclkaudio_config_set(HFCLKAUDIO_12_288_MHZ);

    NRF_CLOCK->TASKS_HFCLKAUDIOSTART = 1;

    /* Wait for ACLK to start */
    // while (!NRF_CLOCK_EVENT_HFCLKAUDIOSTARTED)
    while (NRF_CLOCK->EVENTS_HFCLKAUDIOSTARTED == 0)
    {
        k_sleep(K_MSEC(1));
    }

    ret = pinctrl_apply_state(PINCTRL_DT_DEV_CONFIG_GET(I2S_NL), PINCTRL_STATE_DEFAULT);
    __ASSERT_NO_MSG(ret == 0);

    IRQ_CONNECT(DT_IRQN(I2S_NL), DT_IRQ(I2S_NL, priority), nrfx_isr, nrfx_i2s_0_irq_handler, 0);
    irq_enable(DT_IRQN(I2S_NL));

    ret = nrfx_i2s_init(&i2s_inst, &cfg, i2s_buffer_req_evt_handle);
    __ASSERT_NO_MSG(ret == NRFX_SUCCESS);

    state = AUDIO_I2S_STATE_IDLE;
    LOG_INF("Audio I2S initialized OK!!!");
}

void i2s_pcm_player(void *i2c_pcm_data, int16_t i2c_pcm_size, uint8_t i2s_pcm_ch)
{
    // 测试1块板子，1个麦克风，左右声道都播放此麦克风声音声道; Test 1 board, 1 microphone, both left and right channels
    // play this microphone sound channel 测试2块板子，2个麦克风，一个为左声道，一个为右声道，播放立体声; T
    // est 2 boards,2 microphones, one for left channel, one for right channel, play stereo

#ifdef CONFIG_USER_STEREO_1RX_L_1RX_R
#if 1
    // pcm数据缓存buffer; pcm data buffer

    static int16_t spcm_data[2][PDM_PCM_REQ_BUFFER_SIZE] = {0};
    int16_t       *pcm_data                              = (int16_t *)i2c_pcm_data;

    static uint8_t spcm_ch      = 0;
    static uint8_t pcm_ch       = 0;
    uint8_t        pcm_ch_state = 0;
    // 获取通道状态，有通道切换，则合并播放为立体声，没有通道切换，则播放单个通道声音; Get channel status, if there is
    // channel switching, merge and play as stereo, if not, play single channel sound
    pcm_ch       = (i2s_pcm_ch == 1) ? (0) : (1);
    pcm_ch_state = spcm_ch ^ pcm_ch;  //=0单声道 = 1双声道；0： Single channel, 1: Stereo
    spcm_ch      = pcm_ch;
    // 单声道; Single channel
    if (!pcm_ch_state)
    {
        for (uint16_t i = 0; i < i2c_pcm_size; i++)
        {
            uint32_t *p_word        = &mp_block_to_fill[i];
            ((uint16_t *)p_word)[0] = (uint16_t)pcm_data[i] - 1;  // 填充左声道数据；Fill left channel data
            ((uint16_t *)p_word)[1] = (uint16_t)pcm_data[i] + 1;  // 填充右声道数据；Fill right channel data
        }
    }
    else  // 双声道切换; Stereo channel switching
    {
        for (uint16_t i = 0; i < i2c_pcm_size; i++)
        {
            spcm_data[pcm_ch][i] = pcm_data[i];  // 备份当前声道数据； Backup current channel data
            // 先获取到左声道数据，再获取到右声道数据，获取到右声道数据时播放一帧立体声数据; First get the left channel
            // data, then get the right channel data, when the right channel data is obtained, play a frame of stereo
            // data
            if (pcm_ch)
            {
                uint32_t *p_word        = &mp_block_to_fill[i];
                ((uint16_t *)p_word)[0] = (uint16_t)spcm_data[0][i] - 1;  // 填充左声道数据；Fill left channel data
                ((uint16_t *)p_word)[1] = (uint16_t)spcm_data[1][i] + 1;  // 填充右声道数据；Fill right channel data
            }
            spcm_data[!pcm_ch][i] = 0;  // 清除上次声道数据; Clear the previous channel data
        }
    }
#endif
#endif

// 测试2块板子，2个麦克风，每个麦克风都是左声道，按照板子1; Test 2 boards, 2 microphones, each microphone is left
// channel, according to board 1 板子2顺序，左右声道都播放左声道; Board 2 order, both left and right channels play left
// channel
#ifdef CONFIG_USER_STEREO_2RX_L
    // 填充单声道为立体声播放开始; Start filling mono as stereo playback
    int16_t *pcm_data = (int16_t *)i2c_pcm_data;
    for (uint16_t i = 0; i < i2c_pcm_size; i++)
    {
        uint32_t *p_word        = &mp_block_to_fill[i];
        ((uint16_t *)p_word)[0] = (uint16_t)pcm_data[i]
                                  - 1;  // 左声道数据：= 原始数据 - 1；Left channel data: = original data - 1
        ((uint16_t *)p_word)[1] = (uint16_t)pcm_data[i]
                                  + 1;  // 右声道数据: = 原始数据 + 1；Right channel data: = original data + 1
    }
    // 填充单声道为立体声播放结束; End filling mono as stereo playback

#endif

// 测试1快板子，2个麦克风，播放左右声道声音为立体声; Test 1 board, 2 microphones, play left and right channel sound as
// stereo 测试2块板子，2个麦克风，一个为左声道，一个为右声道，播放立体声
#ifdef CONFIG_USER_STEREO_2RX_LR
    // 填充立体声I2S PCM数据开始
    // Fill stereo I2S PCM data start
    for (uint16_t i = 0; i < i2c_pcm_size; i++)
    {
        uint32_t *p_word        = &mp_block_to_fill[i];
        uint32_t *pcm_data      = (uint32_t *)&i2c_pcm_data[i];
        ((uint16_t *)p_word)[0] = ((uint16_t *)pcm_data)[0] - 6553;  // 左声道数据；Left channel data
        ((uint16_t *)p_word)[1] = ((uint16_t *)pcm_data)[1] + 6553;  // 右声道数据； Right channel data
    }
#endif
}
