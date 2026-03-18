/*
 * @Author       : Cole
 * @Date         : 2025-08-05 18:00:04
 * @LastEditTime : 2025-10-31 09:53:25
 * @FilePath     : mos_audio_i2s.c
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
#include <string.h>
// #include "audio_sync_timer.h"
#include <zephyr/logging/log.h>

#include "mos_audio_i2s.h"
#include "pdm_audio_stream.h"


LOG_MODULE_REGISTER(audio_iis, LOG_LEVEL_DBG);

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
    .mck_setup = NRF_I2S_MCK_32MDIV8,  // 对 ACLK 等价于 ACLK/8 = 12.288M/8 = 1.536 MHz；The ACLK is equivalent to  ACLK/8 = 12.288M/8 = 1.536 MHz
    .ratio = NRF_I2S_RATIO_96X,        // LRCK = 1.536M / 96 = 16 kHz 精准对齐；LRCK = 1.536M / 96 = 16 kHz - Precisely aligned

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
        /* This is normal during I2S stop, don't log as error / 这是 I2S 停止时的正常现象，不记录为错误 */
        LOG_DBG("i2s_buffer_req_evt_handle: No next buffers needed (normal during stop), status = %u", status);
        return;
    }
    // p_released->p_rx_buffer为已经播放完成的缓冲区，可以释放掉或用来填充下一帧播放数据;
    // p_released->p_rx_buffer is the buffer that has finished playing, can be released or used to fill the next frame
    // of playback data
    if (p_released->p_rx_buffer == NULL)
    {
        err_code         = nrfx_i2s_next_buffers_set(&i2s_inst, &i2s_req_buffer[1]);
        mp_block_to_fill = i2s_tx_req_buffer[1];
        // LOG_INF("i2s p_released->p_rx_buffer = %lld\r\n", k_uptime_get() );
    }
    else
    {
        err_code         = nrfx_i2s_next_buffers_set(&i2s_inst, p_released);
        mp_block_to_fill = (uint32_t*)p_released->p_tx_buffer;
        // LOG_INF("i2s next buffers needed = %lld\r\n", k_uptime_get() );
    }
    if (err_code != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx_i2s_next_buffers_set failed: %d", err_code);
    }
}

void audio_i2s_start(void)
{
    if (state != AUDIO_I2S_STATE_IDLE)
    {
        LOG_WRN("I2S start requested while state=%d", state);
        return;
    }

    /* Clear all I2S buffers before starting to avoid pop noise / 启动前清空缓冲区以避免电流声 */
    memset(i2s_tx_req_buffer[0], 0, PDM_PCM_REQ_BUFFER_SIZE * sizeof(uint32_t));
    memset(i2s_tx_req_buffer[1], 0, PDM_PCM_REQ_BUFFER_SIZE * sizeof(uint32_t));

    nrfx_err_t ret;
    /* Buffer size in 32-bit words */
    ret = nrfx_i2s_start(&i2s_inst, &i2s_req_buffer[0], 0);
    if (ret != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx_i2s_start failed: %d", ret);
        return;
    }

    state = AUDIO_I2S_STATE_STARTED;
    LOG_INF("I2S started with clean buffers");
}

void audio_i2s_stop(void)
{
    if (state != AUDIO_I2S_STATE_STARTED)
    {
        LOG_WRN("I2S stop requested while state=%d", state);
        return;
    }

    nrfx_i2s_stop(&i2s_inst);

    state = AUDIO_I2S_STATE_IDLE;
}
/**
 * @brief I2S 音频播放初始化标识
 * returns I2S audio playback initialization flag
 * false: 未初始化；Not initialized
 * true: 已初始化；Initialized
 */
bool audio_i2s_is_initialized(void)
{
    return (state != AUDIO_I2S_STATE_UNINIT);
}

bool audio_i2s_is_started(void)
{
    return (state == AUDIO_I2S_STATE_STARTED);
}

void audio_i2s_uninit(void)
{
    /* Check state / 检查状态 */
    if (state == AUDIO_I2S_STATE_UNINIT)
    {
        LOG_WRN("I2S already uninitialized");
        return;
    }
    
    /* Stop first if still running / 如果还在运行则先停止 */
    if (state == AUDIO_I2S_STATE_STARTED)
    {
        LOG_WRN("I2S is still running, stopping first");
        audio_i2s_stop();
    }
    
    /* Uninitialize I2S driver / 反初始化 I2S 驱动 */
    nrfx_i2s_uninit(&i2s_inst);
    
    /* Disable IRQ / 禁用中断 */
    irq_disable(DT_IRQN(I2S_NL));
    
    /* Put pins to sleep state / 将引脚切换到休眠态 */
    (void)pinctrl_apply_state(PINCTRL_DT_DEV_CONFIG_GET(I2S_NL), PINCTRL_STATE_SLEEP);
    
    /* Stop audio clock / 停止音频时钟 */
    NRF_CLOCK->TASKS_HFCLKAUDIOSTOP = 1;
    NRF_CLOCK->EVENTS_HFCLKAUDIOSTARTED = 0;
    
    /* Reset all state / 重置所有状态 */
    state = AUDIO_I2S_STATE_UNINIT;
    mp_block_to_fill = NULL;
    
    /* Reset I2S output flag to ensure clean state / 重置 I2S 输出标志以确保状态清洁 */
    extern int pdm_audio_set_i2s_output(bool enabled);
    (void)pdm_audio_set_i2s_output(false);
    
    LOG_INF("I2S uninitialized and hardware released");
}

void audio_i2s_init(void)
{
    if (state != AUDIO_I2S_STATE_UNINIT)
    {
        LOG_WRN("I2S init requested while state=%d", state);
        return;
    }

    nrfx_err_t ret;

    nrfx_clock_hfclkaudio_config_set(HFCLKAUDIO_12_288_MHZ);
    
    NRF_CLOCK->EVENTS_HFCLKAUDIOSTARTED = 0;
    NRF_CLOCK->TASKS_HFCLKAUDIOSTART = 1;

    /* Wait for ACLK to start */
    uint32_t wait_cycles = 0;
    while (NRF_CLOCK->EVENTS_HFCLKAUDIOSTARTED == 0)
    {
        k_sleep(K_MSEC(1));
        if (++wait_cycles > 100)
        {
            LOG_ERR("HFCLKAUDIO failed to start");
            NRF_CLOCK->TASKS_HFCLKAUDIOSTOP = 1;
            NRF_CLOCK->EVENTS_HFCLKAUDIOSTARTED = 0;
            return;
        }
    }

    ret = pinctrl_apply_state(PINCTRL_DT_DEV_CONFIG_GET(I2S_NL), PINCTRL_STATE_DEFAULT);
    if (ret != 0)
    {
        LOG_ERR("pinctrl_apply_state failed: %d", ret);
        NRF_CLOCK->TASKS_HFCLKAUDIOSTOP = 1;
        return;
    }

    IRQ_CONNECT(DT_IRQN(I2S_NL), DT_IRQ(I2S_NL, priority), nrfx_isr, nrfx_i2s_0_irq_handler, 0);
    irq_enable(DT_IRQN(I2S_NL));

    ret = nrfx_i2s_init(&i2s_inst, &cfg, i2s_buffer_req_evt_handle);
    if (ret != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx_i2s_init failed: %d", ret);
        irq_disable(DT_IRQN(I2S_NL));
        NRF_CLOCK->TASKS_HFCLKAUDIOSTOP = 1;
        NRF_CLOCK->EVENTS_HFCLKAUDIOSTARTED = 0;
        return;
    }

    state = AUDIO_I2S_STATE_IDLE;
    LOG_INF("Audio I2S initialized OK!!!");
}

void i2s_pcm_player(void *i2c_pcm_data, int16_t i2c_pcm_size, uint8_t i2s_pcm_ch)
{
    // 安全检查：确保 I2S 缓冲区已准备好
    // Safety check: ensure I2S buffer is ready
    if (mp_block_to_fill == NULL || i2c_pcm_data == NULL || i2c_pcm_size <= 0)
    {
        return;  // I2S 未初始化或参数无效，直接返回；I2S not initialized or invalid parameters, return directly
    }
    
    int16_t *pcm_data = (int16_t *)i2c_pcm_data;

    /* 当前测试链路输出单声道样本，复制到左右声道 / Mono loopback -> duplicate to L+R */
    uint16_t samples = (i2c_pcm_size < PDM_PCM_REQ_BUFFER_SIZE) ? i2c_pcm_size : PDM_PCM_REQ_BUFFER_SIZE;
    for (uint16_t i = 0; i < samples; ++i)
    {
        uint32_t *p_word       = &mp_block_to_fill[i];
        ((int16_t *)p_word)[0] = pcm_data[i];
        ((int16_t *)p_word)[1] = pcm_data[i];
    }

    for (uint16_t i = samples; i < PDM_PCM_REQ_BUFFER_SIZE; ++i)
    {
        uint32_t *p_word       = &mp_block_to_fill[i];
        ((int16_t *)p_word)[0] = 0;
        ((int16_t *)p_word)[1] = 0;
    }
}
