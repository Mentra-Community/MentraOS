/*
 * @Author       : Cole
 * @Date         : 2025-08-05 18:00:04
 * @LastEditTime : 2025-12-24 19:38:51
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
#include <string.h>
#include <stdlib.h>  // for abs()
#include <stdio.h>
#include <zephyr/logging/log.h>

#include "bspal_audio_i2s.h"
#include "mos_pdm.h"


LOG_MODULE_REGISTER(audio_iis, LOG_LEVEL_DBG);

// Callback function for received I2S data
static audio_i2s_rx_callback_t rx_callback = NULL;

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
    .mode          = NRF_I2S_MODE_MASTER,  /* Master mode: nRF5340 generates clocks for I2S microphones */
    .format        = NRF_I2S_FORMAT_I2S,
    .alignment     = NRF_I2S_ALIGN_LEFT,
    .sample_width  = NRF_I2S_SWIDTH_16BIT,
    .channels      = NRF_I2S_CHANNELS_STEREO,
    .enable_bypass = false,
    /* Master mode: nRF5340 generates SCK and LRCK for external I2S microphones */
    .clksrc        = NRF_I2S_CLKSRC_ACLK,  /* Audio clock for precise 16kHz sampling */
    .mck_setup     = NRF_I2S_MCK_32MDIV8,  /* MCK = ACLK/8 = 12.288M/8 = 1.536 MHz */
    .ratio         = NRF_I2S_RATIO_96X,    /* LRCK = 1.536M / 96 = 16 kHz */

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
static uint8_t current_buffer_index = 0;

static void i2s_buffer_req_evt_handle(nrfx_i2s_buffers_t const *p_released, uint32_t status)
{
    // Check if I2S is still in STARTED state - if not, ignore events
    if (state != AUDIO_I2S_STATE_STARTED)
    {
        // I2S is stopping or stopped, ignore this event
        return;
    }
    
    static uint32_t event_count = 0;
    static bool first_event_logged = false;
    event_count++;
    
    // Log first event to confirm I2S is receiving clock signals
    if (!first_event_logged)
    {
        LOG_INF("I2S first event received: status=0x%x (I2S master started, generating clocks)", status);
        first_event_logged = true;
    }
    
    uint32_t err_code;
    bool has_rx_data = (p_released && p_released->p_rx_buffer != NULL);
    bool needs_next_buffers = (status & NRFX_I2S_STATUS_NEXT_BUFFERS_NEEDED);
    
    if (!needs_next_buffers && !has_rx_data)
    {
        if (p_released == NULL || p_released->p_rx_buffer == NULL)
        {
            uint8_t next_buffer_index = (current_buffer_index + 1) % 2;
            err_code = nrfx_i2s_next_buffers_set(&i2s_inst, &i2s_req_buffer[next_buffer_index]);
            if (err_code != NRFX_SUCCESS)
            {
                LOG_ERR("Failed to set initial I2S buffers: %d", err_code);
            } 
            else 
            {
                current_buffer_index = next_buffer_index;
            }
        }
        return;
    }
    
    if (has_rx_data)
    {
        size_t sample_count = p_released->buffer_size * 2;
        const int16_t *rx_samples = (const int16_t *)p_released->p_rx_buffer;
        
        // Log data reception (first 10 buffers, then every 100th to avoid log spam)
        static uint32_t rx_buffer_count = 0;
        rx_buffer_count++;
        if (rx_buffer_count <= 10 || rx_buffer_count % 100 == 0)
        {
            LOG_INF("🎵 I2S RX buffer #%u: received %u samples (%u bytes) from I2S microphones", 
                    rx_buffer_count, sample_count, sample_count * sizeof(int16_t));
            if (rx_buffer_count <= 3)
            {
                // Show first few sample values to confirm data is valid
                LOG_INF("   First samples: L[0]=%d, R[0]=%d, L[1]=%d, R[1]=%d", 
                        rx_samples[0], rx_samples[1], 
                        sample_count > 2 ? rx_samples[2] : 0,
                        sample_count > 3 ? rx_samples[3] : 0);
            }
        }
        
        if (rx_callback != NULL)
        {
            rx_callback(rx_samples, sample_count * sizeof(int16_t));
        }
        else
        {
            if (rx_buffer_count <= 5)
            {
                LOG_WRN("⚠️ I2S data received but no callback set! Set callback with audio_i2s_set_rx_callback()");
                LOG_WRN("💡 Enable audio system (pdm_audio_stream_set_enabled) to process I2S data");
            }
        }
    }
    
    if (needs_next_buffers || p_released != NULL)
    {
        uint8_t next_buffer_index;
        
        if (p_released != NULL && p_released->p_rx_buffer != NULL)
        {
            if (p_released->p_rx_buffer == i2s_rx_req_buffer[0])
            {
                current_buffer_index = 0;
                next_buffer_index = 1;
            }
            else if (p_released->p_rx_buffer == i2s_rx_req_buffer[1])
            {
                current_buffer_index = 1;
                next_buffer_index = 0;
            }
            else
            {
                next_buffer_index = (current_buffer_index + 1) % 2;
            }
        }
        else
        {
            next_buffer_index = (current_buffer_index + 1) % 2;
        }
        
        // Set mp_block_to_fill to indicate which TX buffer is ready to be filled
        // Note: TX buffer is used for I2S headphone output (I2S is in master mode)
        mp_block_to_fill = i2s_tx_req_buffer[next_buffer_index];
        
        nrfx_i2s_buffers_t *next_buffers = (nrfx_i2s_buffers_t *)&i2s_req_buffer[next_buffer_index];
        current_buffer_index = next_buffer_index;
        
        err_code = nrfx_i2s_next_buffers_set(&i2s_inst, next_buffers);
        if (err_code != NRFX_SUCCESS)
        {
            LOG_ERR("Failed to set next I2S buffers: %d", err_code);
        }
    }
    else
    {
        uint8_t next_buffer_index = (current_buffer_index + 1) % 2;
        err_code = nrfx_i2s_next_buffers_set(&i2s_inst, &i2s_req_buffer[next_buffer_index]);
        if (err_code != NRFX_SUCCESS)
        {
            LOG_ERR("Failed to set I2S buffers: %d", err_code);
        }
        else
        {
            current_buffer_index = next_buffer_index;
        }
    }
}

void audio_i2s_start(void)
{
    // Initialize I2S if not already initialized
    if (state == AUDIO_I2S_STATE_UNINIT)
    {
        LOG_INF("I2S not initialized, initializing now...");
        audio_i2s_init();
    }
    
    if (state == AUDIO_I2S_STATE_STARTED)
    {
        LOG_WRN("I2S already started, stopping first for clean restart");
        // Use audio_i2s_stop() instead of direct nrfx_i2s_stop() to ensure proper state management
        // This avoids potential blocking issues with nrfx_i2s_stop()
        audio_i2s_stop();
        // Wait a bit for I2S to fully stop
        k_sleep(K_MSEC(10));
    }
    
    if (state != AUDIO_I2S_STATE_IDLE)
    {
        LOG_ERR("I2S state is not IDLE (state=%d), cannot start", state);
        return;
    }
    
    memset(i2s_rx_req_buffer[0], 0, sizeof(i2s_rx_req_buffer[0]));
    memset(i2s_rx_req_buffer[1], 0, sizeof(i2s_rx_req_buffer[1]));
    memset(i2s_tx_req_buffer[0], 0, sizeof(i2s_tx_req_buffer[0]));
    memset(i2s_tx_req_buffer[1], 0, sizeof(i2s_tx_req_buffer[1]));
    
    // Initialize mp_block_to_fill to first TX buffer
    mp_block_to_fill = i2s_tx_req_buffer[0];
    
    nrfx_err_t ret = nrfx_i2s_start(&i2s_inst, &i2s_req_buffer[0], 0);
    if (ret != NRFX_SUCCESS)
    {
        LOG_ERR("Failed to start I2S: %d", ret);
        return;
    }

    state = AUDIO_I2S_STATE_STARTED;
    LOG_INF("I2S started successfully (master mode)");
    LOG_INF("I2S master mode: generating clock signals (SCK, LRCK) for I2S microphones");
    LOG_INF("Generating signals: SCK (P1.08), LRCK (P1.06) to I2S microphones");
    LOG_INF("Data input: SDIN (P1.09) - receiving stereo data from I2S microphones");
    LOG_INF("Data output: SDOUT (P1.10) - sending data to I2S headphones");
}

void audio_i2s_stop(void)
{
    if (state != AUDIO_I2S_STATE_STARTED)
    {
        LOG_WRN("I2S stop called but state is not STARTED (state=%d), skipping", state);
        return;
    }

    LOG_INF("Stopping I2S...");
    // Set state first to prevent event handler from processing new events
    state = AUDIO_I2S_STATE_IDLE;
    // Then stop hardware
    nrfx_i2s_stop(&i2s_inst);
    LOG_INF("I2S stopped successfully");
}

void audio_i2s_init(void)
{
    __ASSERT_NO_MSG(state == AUDIO_I2S_STATE_UNINIT);

    nrfx_err_t ret;

    nrfx_clock_hfclkaudio_config_set(HFCLKAUDIO_12_288_MHZ);
    NRF_CLOCK->TASKS_HFCLKAUDIOSTART = 1;

    uint32_t wait_count = 0;
    while (NRF_CLOCK->EVENTS_HFCLKAUDIOSTARTED == 0)
    {
        k_sleep(K_MSEC(1));
        wait_count++;
        if (wait_count > 100)
        {
            LOG_ERR("Timeout waiting for HFCLKAUDIO to start!");
            return;
        }
    }

    ret = pinctrl_apply_state(PINCTRL_DT_DEV_CONFIG_GET(I2S_NL), PINCTRL_STATE_DEFAULT);
    __ASSERT_NO_MSG(ret == 0);

    IRQ_CONNECT(DT_IRQN(I2S_NL), DT_IRQ(I2S_NL, priority), nrfx_isr, nrfx_i2s_0_irq_handler, 0);
    irq_enable(DT_IRQN(I2S_NL));

    ret = nrfx_i2s_init(&i2s_inst, &cfg, i2s_buffer_req_evt_handle);
    __ASSERT_NO_MSG(ret == NRFX_SUCCESS);

    state = AUDIO_I2S_STATE_IDLE;
    LOG_INF("I2S initialized successfully (master mode)");
}

void audio_i2s_set_rx_callback(audio_i2s_rx_callback_t callback)
{
    rx_callback = callback;
}

void audio_i2s_set_next_buf(const uint8_t *tx_buf, uint32_t *rx_buf)
{
    if (tx_buf != NULL && mp_block_to_fill != NULL)
    {
        // Copy TX data to the buffer that will be sent next
        memcpy(mp_block_to_fill, tx_buf, PDM_PCM_REQ_BUFFER_SIZE * sizeof(uint32_t));
        LOG_DBG("TX buffer filled with audio data");
    }
    
    if (rx_buf != NULL)
    {
        // Store RX buffer pointer if needed
        // Currently handled by event callback
    }
}

void i2s_pcm_player(void *i2c_pcm_data, int16_t i2c_pcm_size, uint8_t i2s_pcm_ch)
{
    // Check if TX buffer is available (mp_block_to_fill is set by I2S event callback)
    if (mp_block_to_fill == NULL)
    {
        static uint32_t null_buffer_warn_count = 0;
        null_buffer_warn_count++;
        if (null_buffer_warn_count <= 5 || null_buffer_warn_count % 100 == 0)
        {
            LOG_WRN("I2S TX buffer not ready (mp_block_to_fill is NULL) #%u, skipping playback", null_buffer_warn_count);
        }
        return;
    }
    
    if (i2c_pcm_data == NULL || i2c_pcm_size <= 0)
    {
        static uint32_t invalid_data_warn_count = 0;
        invalid_data_warn_count++;
        if (invalid_data_warn_count <= 5 || invalid_data_warn_count % 100 == 0)
        {
            LOG_WRN("Invalid PCM data parameters #%u (data=%p, size=%d), skipping playback", 
                invalid_data_warn_count, i2c_pcm_data, i2c_pcm_size);
        }
        return;
    }
    // pcm数据缓存buffer; pcm data buffer
    static int16_t spcm_data[2][PDM_PCM_REQ_BUFFER_SIZE] = {0};
    int16_t       *pcm_data                              = (int16_t *)i2c_pcm_data;

    static uint8_t spcm_ch      = 0;
    static uint8_t pcm_ch       = 0;
    uint8_t        pcm_ch_state = 0;

    pcm_ch       = i2s_pcm_ch;  // Direct mapping: 0=left, 1=right
    pcm_ch_state = spcm_ch ^ pcm_ch;  //=0单声道 = 1双声道；0： Single channel, 1: Stereo
    spcm_ch      = pcm_ch;
    
    static uint32_t player_call_count = 0;
    static uint32_t last_call_time = 0;
    player_call_count++;
    uint32_t current_time = k_cycle_get_32();
    uint32_t time_since_last_call = (last_call_time > 0) ? (current_time - last_call_time) : 0;
    last_call_time = current_time;
    
    if (player_call_count <= 10 || player_call_count % 200 == 0)
    {
        LOG_INF("[DEBUG] i2s_pcm_player call #%u: i2s_pcm_ch=%u, pcm_ch=%u, pcm_ch_state=%u (stereo=%d), time_since_last=%u cycles", 
            player_call_count, i2s_pcm_ch, pcm_ch, pcm_ch_state, pcm_ch_state == 1, time_since_last_call);
        if (i2c_pcm_size > 0)
        {
            LOG_INF("[DEBUG] Input data: pcm_data[0]=%d, pcm_data[1]=%d, pcm_data[2]=%d, size=%u", 
                pcm_data[0], (i2c_pcm_size > 2) ? pcm_data[1] : 0, (i2c_pcm_size > 4) ? pcm_data[2] : 0, i2c_pcm_size);
        }
    }
    
    // Limit sample count to buffer size
    uint16_t samples_to_process = (i2c_pcm_size > PDM_PCM_REQ_BUFFER_SIZE) ? PDM_PCM_REQ_BUFFER_SIZE : i2c_pcm_size;
    
    if (!pcm_ch_state && pcm_ch != 0 && pcm_ch != 1)
    {
        for (uint16_t i = 0; i < samples_to_process; i++)
        {
            uint32_t *p_word        = &mp_block_to_fill[i];
            ((uint16_t *)p_word)[0] = (uint16_t)pcm_data[i];  // 填充左声道数据；Fill left channel data (removed -1 offset)
            ((uint16_t *)p_word)[1] = (uint16_t)pcm_data[i];  // 填充右声道数据；Fill right channel data (removed +1 offset)
        }
    }
    else  // 双声道切换; Stereo channel switching (always use this branch in stereo mode)
    {
        for (uint16_t i = 0; i < samples_to_process; i++)
        {
            spcm_data[pcm_ch][i] = pcm_data[i];  // 备份当前声道数据； Backup current channel data
            if (pcm_ch == 1)  // Right channel received - we now have both L and R, so play stereo
            {
                uint32_t *p_word        = &mp_block_to_fill[i];
                int16_t l_val = spcm_data[0][i];
                int16_t r_val = spcm_data[1][i];
                ((uint16_t *)p_word)[0] = (uint16_t)l_val;  // 填充左声道数据；Fill left channel data (from previous call)
                ((uint16_t *)p_word)[1] = (uint16_t)r_val;  // 填充右声道数据；Fill right channel data (current call)
            }
            else  // pcm_ch == 0, left channel - just store, wait for right channel
            {
                if (i == 0 && (player_call_count <= 10 || player_call_count % 200 == 0))
                {
                    LOG_INF("[DEBUG] Storing left channel data: spcm_data[0][0]=%d (from pcm_data[0]=%d, waiting for right channel to play stereo)", 
                        spcm_data[0][i], pcm_data[i]);
                }
            }
        }
    }
}
