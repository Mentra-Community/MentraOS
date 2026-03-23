/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-07-31 16:45:15
 * @FilePath     : mos_pdm.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

// #include <bluetooth/audio/lc3.h>
#include <nrfx_pdm.h>
#include "mos_pdm.h"
#include "bsp_log.h"
#include "bal_os.h"

#define TAG "MOS_LE_AUDIO"

static K_SEM_DEFINE(pcmsem, 0, 1);

#ifdef CONFIG_NRFX_PDM

//==============================================================================================
#define NRF_GPIO_PIN_MAP(port, pin) (((port) << 5) | ((pin) & 0x1F))
#define PDM_CLK NRF_GPIO_PIN_MAP(1, 12)
#define PDM_DIN NRF_GPIO_PIN_MAP(1, 11)
int16_t pcm_req_buffer[2][PDM_PCM_REQ_BUFFER_SIZE] = {0};
uint8_t pcm_req_id = 0;
uint8_t pdm_req_flag = 0;
uint32_t pcm_req_buffer_size = (PDM_PCM_REQ_BUFFER_SIZE << 1);

static const nrfx_pdm_t m_pdm = NRFX_PDM_INSTANCE(0);
static void pcm_buffer_req_evt_handle(const nrfx_pdm_evt_t *evt)
{
    // 申请PCM采样缓存事件
    if (evt->buffer_requested)
    {
        // 申请本次PCM采样缓存
        nrfx_pdm_buffer_set(&m_pdm, pcm_req_buffer[pcm_req_id], PDM_PCM_REQ_BUFFER_SIZE);

        // 切换采样buffer
        pcm_req_id ^= 1;

        // 设置采样到一组数据标志
#if 1

        mos_sem_give(&pcmsem);
#else
        pdm_req_flag = 1;
#endif
    }
}

// ISR_DIRECT_DECLARE(pdm_isr_handler)
// {
//     nrfx_pdm_irq_handler();
//     ISR_DIRECT_PM();
//     return 1;
// }

void pdm_init(void)
{
    uint32_t err_code;

    // IRQ_DIRECT_CONNECT(PDM0_IRQn, 0, pdm_isr_handler, 0);
    nrfx_pdm_config_t pdm_config = NRFX_PDM_DEFAULT_CONFIG(PDM_CLK, PDM_DIN);
    pdm_config.mode = NRF_PDM_MODE_MONO;
    pdm_config.clk_pin = PDM_CLK;
    pdm_config.din_pin = PDM_DIN;
    pdm_config.edge = NRF_PDM_EDGE_LEFTRISING;
    pdm_config.clock_freq = NRF_PDM_FREQ_1032K;
    pdm_config.gain_l = NRF_PDM_GAIN_DEFAULT;
    pdm_config.gain_r = NRF_PDM_GAIN_DEFAULT;
    pdm_config.interrupt_priority = NRFX_PDM_DEFAULT_CONFIG_IRQ_PRIORITY;
    pdm_config.ratio = NRF_PDM_RATIO_64X;
    err_code = nrfx_pdm_init(&m_pdm, &pdm_config, pcm_buffer_req_evt_handle);
    if (err_code != NRFX_SUCCESS)
    {
        BSP_LOGE(TAG, "nrfx pdm init err = %08X", err_code);
    }
}

void pdm_start(void)
{
    BSP_LOGI(TAG, "pdm_start");
    uint32_t err_code = nrfx_pdm_start(&m_pdm);
    if (err_code != NRFX_SUCCESS)
    {
        BSP_LOGE(TAG, "nrfx pdm start err = %08X", err_code);
    }
    else
    {
        BSP_LOGI(TAG, "pdm started successfully");
    }
}

void pdm_stop(void)
{
    BSP_LOGI(TAG, "pdm_stop");
    uint32_t err_code = nrfx_pdm_stop(&m_pdm);
    if (err_code != NRFX_SUCCESS)
    {
        BSP_LOGE(TAG, "nrfx pdm stop err = %08X", err_code);
    }
    else
    {
        BSP_LOGI(TAG, "pdm stopped successfully");
    }
}

uint32_t get_pdm_sample(int16_t *pdm_pcm_data, uint32_t pdm_pcm_szie)
{
    uint32_t err_code = 0;
#if 1
    mos_sem_take(&pcmsem, MOS_OS_WAIT_FOREVER);
    for (uint32_t i = 0; i < pdm_pcm_szie; i++)
    {
        pdm_pcm_data[i] = pcm_req_buffer[pcm_req_id][i];
    }
    // BSP_LOGI(TAG, "GET PCM DATA:%d", pdm_pcm_szie);
    // BSP_LOG_BUFFER_HEX(TAG, pdm_pcm_data, pdm_pcm_szie * sizeof(int16_t));
#else

    if (pdm_req_flag)
    {
        pdm_req_flag = 0;

        for (uint32_t i = 0; i < pdm_pcm_szie; i++)
        {
            pdm_pcm_data[i] = pcm_req_buffer[pcm_req_id][i];
        }
    }
    else
    {
        err_code = 1; // 未获取到数据
    }
#endif

    return err_code;
}

#endif