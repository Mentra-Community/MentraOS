/*
 * @Author       : XK
 * @Date         : 2025-07-11 14:47:32
 * @LastEditTime : 2025-07-14 14:58:17
 * @FilePath     : bspal_gx8002.c
 * @Description  :
 *
 * Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved.
 */
#include "bal_os.h"
#include "bsp_log.h"
#include "bsp_gx8002.h"
#include "bspal_gx8002.h"

#define TAG "BSPAL_GX8002"

int gx8002_get_mic_state(void)
{
    int ret;
    uint8_t state = 0;

    /* 先写触发命令 0x70 */
    ret = gx8002_i2c_write_reg(0xC4, 0x70);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "write mic-cmd failed: %d", ret);
        return ret;
    }

    /* 等待芯片内部更新 */
    xyzn_os_delay_ms(400);
    /* 再读寄存器 0xA0 */
    gx8002_i2c_start();
    gx8002_write_byte((GX8002_I2C_ADDR << 1) | 0);
    gx8002_write_byte(0xA0);
    gx8002_i2c_stop();
    gx8002_i2c_start();
    gx8002_write_byte((GX8002_I2C_ADDR << 1) | 1);
    gx8002_read_byte(&state, false);
    gx8002_i2c_stop();
    if (ret < 0)
    {
        BSP_LOGE(TAG, "read mic-state failed: %d", ret);
        return ret;
    }
    BSP_LOGI(TAG, "mic state[0:异常 1:正常] = %d", state);
    return state;
}

int gx8002_test_link(void)
{
    int ret;
    uint8_t val = 0;
    const uint8_t irq_cmd = 0x80;
    const uint8_t ack_cmd = 0x11;

    /* 发链路测试中断 */
    ret = gx8002_i2c_write_reg(0xC4, irq_cmd);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "write test-link cmd failed: %d", ret);
        return ret;
    }

    /* 轮询等待 1 (最多 100 次 * 10ms) */
    for (int i = 0; i < 100; i++)
    {
        xyzn_os_delay_ms(10);
        ret = gx8002_i2c_read_reg(0xAC, &val);
        if (ret < 0)
        {
            BSP_LOGE(TAG, "read link-status failed: %d", ret);
            return ret;
        }
        if (val == 1)
        {
            /* 回写确认 */
            ret = gx8002_i2c_write_reg(0xC4, ack_cmd);
            if (ret < 0)
            {
                BSP_LOGE(TAG, "ack test-link failed: %d", ret);
                return ret;
            }
            BSP_LOGI(TAG, "I2C link OK");
            return 1;
        }
    }

    BSP_LOGE(TAG, "I2C link timeout");
    return 0;
}

/**
 * @brief  打开 Dmic
 *         写 0x72 到 0xC4，轮询读 0xA0 等待返回 0x72
 * @return 0 成功；<0 I2C 错误
 */
int gx8002_open_dmic(void)
{
    int ret;
    uint8_t val = 0;
    const uint8_t cmd = 0x72;

    ret = gx8002_i2c_write_reg(0xC4, cmd);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "write open-dmic failed: %d", ret);
        return ret;
    }

    for (int i = 0; i < 100; i++)
    {
        xyzn_os_delay_ms(10);
        ret = gx8002_i2c_read_reg(0xA0, &val);
        if (ret < 0)
        {
            BSP_LOGE(TAG, "read open-dmic status failed: %d", ret);
            return ret;
        }
        if (val == cmd)
        {
            BSP_LOGI(TAG, "open dmic OK");
            return 0;
        }
    }

    BSP_LOGE(TAG, "open dmic timeout");
    return XYZN_OS_ERROR;
}

/**
 * @brief  关闭 Dmic
 *         写 0x73 到 0xC4，轮询读 0xA0 等待返回 0x73
 * @return 0 成功；<0 I2C 错误
 */
int gx8002_close_dmic(void)
{
    int ret;
    uint8_t val = 0;
    const uint8_t cmd = 0x73;

    ret = gx8002_i2c_write_reg(0xC4, cmd);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "write close-dmic failed: %d", ret);
        return ret;
    }

    for (int i = 0; i < 100; i++)
    {
        xyzn_os_delay_ms(10);
        ret = gx8002_i2c_read_reg(0xA0, &val);
        if (ret < 0)
        {
            BSP_LOGE(TAG, "read close-dmic status failed: %d", ret);
            return ret;
        }
        if (val == cmd)
        {
            BSP_LOGI(TAG, "close dmic OK");
            return 0;
        }
    }

    BSP_LOGE(TAG, "close dmic timeout");
    return XYZN_OS_ERROR;
}
int gx8002_reset(void)
{
    int ret;
    ret = gx8002_i2c_write_reg(0x9C, 0xA5);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "reset step1 (9C=A5) failed: %d", ret);
        return ret;
    }
    xyzn_os_delay_ms(1);

    ret = gx8002_i2c_write_reg(0xD0, 0x5A);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "reset step2 (D0=5A) failed: %d", ret);
        return ret;
    }
    xyzn_os_delay_ms(1);

    ret = gx8002_i2c_write_reg(0xCC, 0x04);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "reset step3 (CC=04) failed: %d", ret);
        return ret;
    }
    xyzn_os_delay_ms(1);

    ret = gx8002_i2c_write_reg(0xB0, 0x01);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "reset step4 (B0=01) failed: %d", ret);
        return ret;
    }

    BSP_LOGI(TAG, "software reset sequence sent");
    return 0;
}
int gx8002_read_voice_event(void)
{
    /*
    小度小度 101
    天猫精灵 102
    接听电话 103
    挂掉电话 115
    挂断电话 104
    暂停播放 107
    停止播放 108
    播放音乐 105
    增大音量 109
    减小音量 106
     */
    int ret;
    uint8_t event_id = 0;

    /* 1 从寄存器 0xA0 读事件 ID */
    ret = gx8002_i2c_read_reg(0xA0, &event_id);
    if (ret < 0)
    {
        BSP_LOGE(TAG, "read event reg failed: %d", ret);
        return ret;
    }

    /* 2 如果有事件，写确认码清除它 */
    if (event_id > 0)
    {
        const uint8_t confirm_code = 0x10;
        ret = gx8002_i2c_write_reg(0xC4, confirm_code);
        if (ret < 0)
        {
            BSP_LOGE(TAG, "confirm event failed: %d", ret);
            return ret;
        }
        BSP_LOGI(TAG, "voice event ID=%d confirmed", event_id);
    }

    return event_id;
}
