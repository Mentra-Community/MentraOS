/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-20 09:30:48
 * @FilePath     : bspal_gx8002.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "bspal_gx8002.h"

#include <zephyr/logging/log.h>

#include "bal_os.h"
#include "bsp_gx8002.h"
#define LOG_MODULE_NAME BSPAL_GX8002
LOG_MODULE_REGISTER(LOG_MODULE_NAME);


int gx8002_get_mic_state(void)
{
    int     ret;
    uint8_t state = 0;
    ret           = gx8002_i2c_write_reg(0xC4, 0x70);
    if (ret < 0)
    {
        LOG_ERR("write mic-cmd failed: %d", ret);
        return ret;
    }
    mos_delay_ms(400);  // wait for mic state ready
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
        LOG_ERR("read mic-state failed: %d", ret);
        return ret;
    }
    LOG_INF("mic state[0: err 1: ok] = %d", state);
    return state;
}

int gx8002_test_link(void)
{
    int           ret;
    uint8_t       val     = 0;
    const uint8_t irq_cmd = 0x80;
    const uint8_t ack_cmd = 0x11;

    ret = gx8002_i2c_write_reg(0xC4, irq_cmd);
    if (ret < 0)
    {
        LOG_ERR("write test-link cmd failed: %d", ret);
        return ret;
    }

    for (int i = 0; i < 100; i++)
    {
        mos_delay_ms(10);
        ret = gx8002_i2c_read_reg(0xAC, &val);
        if (ret < 0)
        {
            LOG_ERR("read link-status failed: %d", ret);
            return ret;
        }
        if (val == 1)
        {
            ret = gx8002_i2c_write_reg(0xC4, ack_cmd);
            if (ret < 0)
            {
                LOG_ERR("ack test-link failed: %d", ret);
                return ret;
            }
            LOG_INF("I2C link OK");
            return 1;
        }
    }

    LOG_ERR("I2C link timeout");
    return 0;
}

int gx8002_open_dmic(void)
{
    int           ret;
    uint8_t       val = 0;
    const uint8_t cmd = 0x72;

    ret = gx8002_i2c_write_reg(0xC4, cmd);
    if (ret < 0)
    {
        LOG_ERR("write open-dmic failed: %d", ret);
        return ret;
    }

    for (int i = 0; i < 100; i++)
    {
        mos_delay_ms(10);
        ret = gx8002_i2c_read_reg(0xA0, &val);
        if (ret < 0)
        {
            LOG_ERR("read open-dmic status failed: %d", ret);
            return ret;
        }
        if (val == cmd)
        {
            LOG_INF("open dmic OK");
            return 0;
        }
    }

    LOG_ERR("open dmic timeout");
    return MOS_OS_ERROR;
}

int gx8002_close_dmic(void)
{
    int           ret;
    uint8_t       val = 0;
    const uint8_t cmd = 0x73;

    ret = gx8002_i2c_write_reg(0xC4, cmd);
    if (ret < 0)
    {
        LOG_ERR("write close-dmic failed: %d", ret);
        return ret;
    }

    for (int i = 0; i < 100; i++)
    {
        mos_delay_ms(10);
        ret = gx8002_i2c_read_reg(0xA0, &val);
        if (ret < 0)
        {
            LOG_ERR("read close-dmic status failed: %d", ret);
            return ret;
        }
        if (val == cmd)
        {
            LOG_INF("close dmic OK");
            return 0;
        }
    }

    LOG_ERR("close dmic timeout");
    return MOS_OS_ERROR;
}
int gx8002_reset(void)
{
    int ret;
    ret = gx8002_i2c_write_reg(0x9C, 0xA5);
    if (ret < 0)
    {
        LOG_ERR("reset step1 (9C=A5) failed: %d", ret);
        return ret;
    }
    mos_delay_ms(1);

    ret = gx8002_i2c_write_reg(0xD0, 0x5A);
    if (ret < 0)
    {
        LOG_ERR("reset step2 (D0=5A) failed: %d", ret);
        return ret;
    }
    mos_delay_ms(1);

    ret = gx8002_i2c_write_reg(0xCC, 0x04);
    if (ret < 0)
    {
        LOG_ERR("reset step3 (CC=04) failed: %d", ret);
        return ret;
    }
    mos_delay_ms(1);

    ret = gx8002_i2c_write_reg(0xB0, 0x01);
    if (ret < 0)
    {
        LOG_ERR("reset step4 (B0=01) failed: %d", ret);
        return ret;
    }

    LOG_INF("software reset sequence sent");
    return 0;
}
int gx8002_read_voice_event(void)
{
    /*
    Voice Command Event IDs:
    小度小度 101     - "Xiao Du Xiao Du" (voice assistant wake-up)
    天猫精灵 102     - "Tmall Genie" (voice assistant wake-up)
    接听电话 103     - "Answer call"
    挂掉电话 115     - "Hang up call"
    挂断电话 104     - "End call"
    暂停播放 107     - "Pause playback"
    停止播放 108     - "Stop playback"
    播放音乐 105     - "Play music"
    增大音量 109     - "Increase volume"
    减小音量 106     - "Decrease volume"
     */
    int     ret;
    uint8_t event_id = 0;

    ret = gx8002_i2c_read_reg(0xA0, &event_id);
    if (ret < 0)
    {
        LOG_ERR("read event reg failed: %d", ret);
        return ret;
    }

    if (event_id > 0)
    {
        const uint8_t confirm_code = 0x10;
        ret                        = gx8002_i2c_write_reg(0xC4, confirm_code);
        if (ret < 0)
        {
            LOG_ERR("confirm event failed: %d", ret);
            return ret;
        }
        LOG_INF("voice event ID=%d confirmed", event_id);
    }

    return event_id;
}
