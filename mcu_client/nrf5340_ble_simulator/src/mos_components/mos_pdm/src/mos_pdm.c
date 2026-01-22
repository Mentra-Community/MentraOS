/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2026-01-16 10:06:10
 * @FilePath     : mos_pdm.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

// #include <bluetooth/audio/lc3.h>
#include "mos_pdm.h"

#include <nrfx_pdm.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include <errno.h>

#include "bal_os.h"

LOG_MODULE_REGISTER(MOS_LE_AUDIO, LOG_LEVEL_DBG);

#define PCM_FIFO_FRAMES 5
static K_SEM_DEFINE(pcmsem, 0, PCM_FIFO_FRAMES);
static int16_t        pcm_fifo[PCM_FIFO_FRAMES][PDM_PCM_FRAME_SAMPLES];
static int16_t        pdm_hw_buf[2][PDM_PCM_FRAME_SAMPLES];
static uint8_t        pdm_fill_idx = 0;  // 下次填充给 PDM 的 hw buf 索引; next index to fill PDM hw buffer
static const uint32_t pdm_frame_samples = PDM_PCM_FRAME_SAMPLES;
static const uint32_t pdm_frame_bytes   = PDM_PCM_FRAME_BYTES;
static pdm_channel_t  pdm_current_channel = PDM_CHANNEL_STEREO_MIXED;
static bool           pdm_initialized     = false;
static bool           pdm_running         = false;

static volatile uint8_t fifo_head = 0;  // 写指针（中断用）;write pointer (used in interrupt)
static volatile uint8_t fifo_tail = 0;  // 读指针（上层用）;read pointer (used in upper layer)

#ifdef CONFIG_NRFX_PDM

//==============================================================================================
#define NRF_GPIO_PIN_MAP(port, pin) (((port) << 5) | ((pin) & 0x1F))
#define PDM_CLK                     NRF_GPIO_PIN_MAP(0, 20)
#define PDM_DIN                     NRF_GPIO_PIN_MAP(0, 21)

static const nrfx_pdm_config_t pdm_config_default = NRFX_PDM_DEFAULT_CONFIG(PDM_CLK, PDM_DIN);
static nrfx_pdm_config_t       pdm_config;

static inline bool fifo_push(const int16_t *src)
{
    uint8_t next_head = (fifo_head + 1) % PCM_FIFO_FRAMES;
    if (next_head == fifo_tail)
    {
        // FIFO 满了（上层没来得及取），丢弃最新一帧以保实时
        // FIFO is full (upper layer hasn't consumed the data), discard the latest frame to maintain real-time
        return false;
    }
    memcpy(pcm_fifo[fifo_head], src, pdm_frame_bytes);
    fifo_head = next_head;
    return true;
}

static inline bool fifo_pop(int16_t *dst)
{
    if (fifo_tail == fifo_head)
        return false;
    memcpy(dst, pcm_fifo[fifo_tail], pdm_frame_bytes);
    fifo_tail = (fifo_tail + 1) % PCM_FIFO_FRAMES;
    return true;
}

static const nrfx_pdm_t m_pdm = NRFX_PDM_INSTANCE(0);
static void  pcm_buffer_req_evt_handle(const nrfx_pdm_evt_t *evt)
{
    // 1) 有“已释放”的满帧（10ms/160样本） -> 推入小FIFO，并唤醒上层
    // 1) There is a "released" full frame (10ms/160 samples) -> push to small FIFO and wake up upper layer
    if (evt->buffer_released != NULL)
    {
        const int16_t *done = evt->buffer_released;  // 直接就是数据首地址;It is simply the data's starting address.
        (void)fifo_push(done);
        mos_sem_give(&pcmsem);
    }

    // 2) 硬件请求新的写入buffer -> 提供下一块10ms缓冲
    // 2) Hardware requests a new write buffer -> provide the next 10ms buffer
    if (evt->buffer_requested)
    {
        nrfx_pdm_buffer_set(&m_pdm, pdm_hw_buf[pdm_fill_idx], pdm_frame_samples);
        pdm_fill_idx ^= 1;  // 0/1 交替;Alternate between 0 and 1
    }

    // 3) 错误上报（可选：统计或复位）
    // 3) Error reporting (optional: statistics or reset)
    if (evt->error != NRFX_PDM_NO_ERROR)
    {
        LOG_ERR("nrfx_pdm error=%d", (int)evt->error);
    }
}

void pdm_init(void)
{
    uint32_t          err_code;
    pdm_config         = pdm_config_default;
    pdm_config.clk_pin = PDM_CLK;
    pdm_config.din_pin = PDM_DIN;

    /* 项目默认使用双麦立体声采集，CPU 端再决定取左、取右或混音 */
    pdm_config.mode = NRF_PDM_MODE_STEREO;
    pdm_config.edge = NRF_PDM_EDGE_LEFTRISING;
    pdm_config.clock_freq        = NRF_PDM_FREQ_1280K;
    pdm_config.ratio             = NRF_PDM_RATIO_80X;

    pdm_config.gain_l             = NRF_PDM_GAIN_DEFAULT;
    pdm_config.gain_r             = NRF_PDM_GAIN_DEFAULT;
    pdm_config.interrupt_priority = NRFX_PDM_DEFAULT_CONFIG_IRQ_PRIORITY;

    err_code = nrfx_pdm_init(&m_pdm, &pdm_config, pcm_buffer_req_evt_handle);
    if (err_code != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx pdm init err = %08X", err_code);
        pdm_initialized = false;
    }
    else
    {
        pdm_initialized = true;
    }
}

void pdm_start(void)
{
    LOG_INF("pdm_start");

    pdm_fill_idx = 0;
    nrfx_pdm_buffer_set(&m_pdm, pdm_hw_buf[pdm_fill_idx], pdm_frame_samples);
    pdm_fill_idx ^= 1;
    nrfx_pdm_buffer_set(&m_pdm, pdm_hw_buf[pdm_fill_idx], pdm_frame_samples);
    pdm_fill_idx ^= 1;

    /* Clear any stale captured frames before restarting / 重启前清空旧的采样帧 */
    k_sem_reset(&pcmsem);

    // unsigned int key = irq_lock();
    fifo_head = fifo_tail = 0;
    // irq_unlock(key);

    uint32_t err = nrfx_pdm_start(&m_pdm);
    if (err != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx_pdm_start err=0x%08x", err);
        pdm_running = false;
    }
    else
    {
        pdm_running = true;
    }
}

void pdm_stop(void)
{
    LOG_INF("pdm_stop");
    uint32_t err_code = nrfx_pdm_stop(&m_pdm);
    if (err_code != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx pdm stop err = %08X", err_code);
    }
    else
    {
        LOG_INF("pdm stopped successfully");
        pdm_running = false;
    }
}

uint32_t get_pdm_sample(int16_t *pdm_pcm_data, uint32_t pdm_pcm_szie)
{
    if (pdm_pcm_data == NULL || pdm_pcm_szie < pdm_frame_samples)
    {
        LOG_ERR("get_pdm_sample: Invalid parameters, pdm_pcm_data=%p, pdm_pcm_szie=%u", pdm_pcm_data,
                (unsigned)pdm_pcm_szie);
        return MOS_OS_ERROR;  // 目标缓冲太小或空指针；Target buffer too small or null pointer
    }
    /* 等待采集中断给出完整帧 / Block until ISR delivers a full frame */
    mos_sem_take(&pcmsem, MOS_OS_WAIT_FOREVER);

    /* 从 FIFO 读取一帧；几乎不会需要重试，仅在极端竞态下保护 / Pop one frame; retry only as safeguard */
    while (!fifo_pop(pdm_pcm_data))
    {
        ;
    }

    return 0;
}

int pdm_set_channel(pdm_channel_t channel)
{
    if (channel < PDM_CHANNEL_LEFT || channel > PDM_CHANNEL_STEREO_MIXED)
    {
        return -EINVAL;
    }

    pdm_current_channel = channel;
    LOG_INF("PDM channel -> %s (CPU selection/mix)",
            (channel == PDM_CHANNEL_LEFT) ? "left" : (channel == PDM_CHANNEL_RIGHT) ? "right" : "mix");
    return 0;
}

pdm_channel_t pdm_get_channel(void)
{
    return pdm_current_channel;
}

bool pdm_is_running(void)
{
    return pdm_running;
}

bool pdm_is_initialized(void)
{
    return pdm_initialized;
}

uint32_t pdm_get_frame_samples(void)
{
    return pdm_frame_samples;
}

uint32_t pdm_get_frame_bytes(void)
{
    return pdm_frame_bytes;
}

#endif