/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-21 09:51:46
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

#include "bal_os.h"

#define LOG_MODULE_NAME MOS_LE_AUDIO
LOG_MODULE_REGISTER(LOG_MODULE_NAME);

#define PCM_FIFO_FRAMES 5
static K_SEM_DEFINE(pcmsem, 0, PCM_FIFO_FRAMES);
static int16_t pcm_fifo[PCM_FIFO_FRAMES][PDM_PCM_REQ_BUFFER_SIZE];

static int16_t pdm_hw_buf[2][PDM_PCM_REQ_BUFFER_SIZE];
static uint8_t pdm_fill_idx = 0;  // 下次填充给 PDM 的 hw buf 索引; next index to fill PDM hw buffer

static volatile uint8_t fifo_head = 0;  // 写指针（中断用）;write pointer (used in interrupt)
static volatile uint8_t fifo_tail = 0;  // 读指针（上层用）;read pointer (used in upper layer)

#ifdef CONFIG_NRFX_PDM

//==============================================================================================
#define NRF_GPIO_PIN_MAP(port, pin) (((port) << 5) | ((pin) & 0x1F))
#define PDM_CLK                     NRF_GPIO_PIN_MAP(1, 12)
#define PDM_DIN                     NRF_GPIO_PIN_MAP(1, 11)

static inline bool fifo_push(const int16_t *src)
{
    uint8_t next_head = (fifo_head + 1) % PCM_FIFO_FRAMES;
    if (next_head == fifo_tail)
    {
        // FIFO 满了（上层没来得及取），丢弃最新一帧以保实时
        // FIFO is full (upper layer hasn't consumed the data), discard the latest frame to maintain real-time
        return false;
    }
    memcpy(pcm_fifo[fifo_head], src, sizeof(int16_t) * PDM_PCM_REQ_BUFFER_SIZE);
    fifo_head = next_head;
    return true;
}

static inline bool fifo_pop(int16_t *dst)
{
    if (fifo_tail == fifo_head)
        return false;
    memcpy(dst, pcm_fifo[fifo_tail], sizeof(int16_t) * PDM_PCM_REQ_BUFFER_SIZE);
    fifo_tail = (fifo_tail + 1) % PCM_FIFO_FRAMES;
    return true;
}

static const nrfx_pdm_t m_pdm = NRFX_PDM_INSTANCE(0);
static void             pcm_buffer_req_evt_handle(const nrfx_pdm_evt_t *evt)
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
        nrfx_pdm_buffer_set(&m_pdm, pdm_hw_buf[pdm_fill_idx], PDM_PCM_REQ_BUFFER_SIZE);
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
    nrfx_pdm_config_t pdm_config = NRFX_PDM_DEFAULT_CONFIG(PDM_CLK, PDM_DIN);
    pdm_config.mode              = NRF_PDM_MODE_MONO;
    pdm_config.clk_pin           = PDM_CLK;
    pdm_config.din_pin           = PDM_DIN;
    pdm_config.edge              = NRF_PDM_EDGE_LEFTRISING;
    pdm_config.clock_freq        = NRF_PDM_FREQ_1280K;
    pdm_config.ratio             = NRF_PDM_RATIO_80X;

    pdm_config.gain_l             = NRF_PDM_GAIN_DEFAULT;
    pdm_config.gain_r             = NRF_PDM_GAIN_DEFAULT;
    pdm_config.interrupt_priority = NRFX_PDM_DEFAULT_CONFIG_IRQ_PRIORITY;

    err_code = nrfx_pdm_init(&m_pdm, &pdm_config, pcm_buffer_req_evt_handle);
    if (err_code != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx pdm init err = %08X", err_code);
    }
}

void pdm_start(void)
{
    LOG_INF("pdm_start");

    pdm_fill_idx = 0;
    nrfx_pdm_buffer_set(&m_pdm, pdm_hw_buf[pdm_fill_idx], PDM_PCM_REQ_BUFFER_SIZE);
    pdm_fill_idx ^= 1;
    nrfx_pdm_buffer_set(&m_pdm, pdm_hw_buf[pdm_fill_idx], PDM_PCM_REQ_BUFFER_SIZE);
    pdm_fill_idx ^= 1;

    // unsigned int key = irq_lock();
    fifo_head = fifo_tail = 0;
    // irq_unlock(key);

    uint32_t err = nrfx_pdm_start(&m_pdm);
    if (err != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx_pdm_start err=0x%08x", err);
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
    }
}

uint32_t get_pdm_sample(int16_t *pdm_pcm_data, uint32_t pdm_pcm_szie)
{
    if (pdm_pcm_data == NULL || pdm_pcm_szie < PDM_PCM_REQ_BUFFER_SIZE)
    {
        LOG_ERR("get_pdm_sample: Invalid parameters, pdm_pcm_data=%p, pdm_pcm_szie=%u", pdm_pcm_data,
                (unsigned)pdm_pcm_szie);
        return MOS_OS_ERROR;  // 目标缓冲太小或空指针；Target buffer too small or null pointer
    }
    // LOG_INF("get_pdm_sample: %u", (unsigned)pdm_pcm_szie);
    // LOG_HEXDUMP_INF(pdm_pcm_data, PDM_PCM_REQ_BUFFER_SIZE * 2,"Hexdump");
    // for (uint32_t i = 0; i < pdm_pcm_szie; i++)
    // {
    //     printf("0x%04x, ", (uint16_t)pdm_pcm_data[i]);
    //     if ((i + 1) % 16 == 0) printf("\n");
    // }
    // 等待中断回调把一帧放入FIFO（buffer_released时give）
    // Wait for the interrupt callback to put a frame into the FIFO (give on buffer_released)
    mos_sem_take(&pcmsem, MOS_OS_WAIT_FOREVER);

    // 从FIFO弹出一帧（极少数竞态下可能为空，再尝试一次）
    // Pop a frame from the FIFO (in very rare）
    if (!fifo_pop(pdm_pcm_data))
    {
        // 理论上不会发生；保护性重试
        // This should not happen; protective retry
        while (!fifo_pop(pdm_pcm_data))
        {
            /* 可根据系统情况选择yield或短延时 */
            // Yield to other tasks or add a short delay
        }
    }

    // LOG_INF("get_pdm_sample: %u", (unsigned)pdm_pcm_szie);
    return 0;
}

#endif