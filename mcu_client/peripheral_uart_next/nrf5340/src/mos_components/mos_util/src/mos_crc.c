/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-07-31 16:57:06
 * @FilePath     : mos_crc.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "bsp_log.h"
#include "mos_crc.h"

/**
 * @brief 计算 CRC-16/CCITT-FALSE 校验值
 *
 * 标准参数说明（符合 CRC-16/CCITT-FALSE）：
 *   - 多项式（Polynomial）: 0x1021
 *   - 初始值（Initial value）: 0xFFFF
 *   - 输入不反转（RefIn = false）
 *   - 输出不反转（RefOut = false）
 *   - 输出异或值为 0x0000
 *
 * @param ucbuf 指向输入数据的指针
 * @param iLen  输入数据的字节长度
 * @return uint16_t 计算出的 16 位 CRC 校验值
 */
uint16_t mos_crc16_ccitt(uint8_t *ucbuf, uint16_t iLen)
{
    uint32_t i, j;
    uint16_t temp_crc = 0xFFFF;        // 初始值为 0xFFFF
    uint16_t temp_polynomial = 0x1021; // 多项式为 0x1021（CRC-16/CCITT）

    for (j = 0; j < iLen; ++j)
    {
        for (i = 0; i < 8; i++)
        {
            char bit = ((ucbuf[j] >> (7 - i)) & 1);
            char c15 = ((temp_crc >> 15) & 1);
            temp_crc <<= 1;
            if (c15 ^ bit)
            {
                temp_crc ^= temp_polynomial;
            }
        }
    }
    temp_crc &= 0xFFFF;
    return temp_crc;
}

/**
 * @brief 计算 CRC-8 校验值（符合 CRC-8/ITU 标准）
 *
 * 标准参数说明：
 *   - 多项式（Polynomial）: 0x07 （即 x^8 + x^2 + x + 1）
 *   - 初始值（Initial value）: 0x00
 *   - 输入不反转（RefIn = false）
 *   - 输出不反转（RefOut = false）
 *   - 输出异或值（XorOut）: 0x00
 *
 * 适用于标准 CRC-8 应用（如 SMBus、ATM HEC）
 *
 * @param data 输入数据指针
 * @param len  数据长度（字节）
 * @return uint8_t 计算出的 CRC8 值
 */
uint8_t zyzn_crc8(const uint8_t *data, uint16_t len)
{
    uint8_t crc = 0x00;
    uint8_t poly = 0x07;

    for (uint16_t i = 0; i < len; i++)
    {
        crc ^= data[i];
        for (uint8_t j = 0; j < 8; j++)
        {
            if (crc & 0x80)
                crc = (crc << 1) ^ poly;
            else
                crc <<= 1;
        }
    }

    return crc;
}
