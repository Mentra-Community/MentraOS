/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-02 16:06:31
 * @FilePath     : mos_crc.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_crc.h"

/**
 * @brief Calculate CRC-16/CCITT-FALSE checksum
 *
 * Standard parameters (CRC-16/CCITT-FALSE compliant):
 *   - Polynomial: 0x1021
 *   - Initial value: 0xFFFF
 *   - Input not reflected (RefIn = false)
 *   - Output not reflected (RefOut = false)
 *   - Output XOR value: 0x0000
 *
 * @param ucbuf Pointer to the input data
 * @param iLen  Length of the input data in bytes
 * @return uint16_t The calculated 16-bit CRC checksum
 */
uint16_t mos_crc16_ccitt(uint8_t *ucbuf, uint16_t iLen)
{
    uint32_t i, j;
    uint16_t temp_crc        = 0xFFFF;  // 初始值为 0xFFFF;Initial value is 0xFFFF
    uint16_t temp_polynomial = 0x1021;  // 多项式为 0x1021（CRC-16/CCITT）; Polynomial is 0x1021 (CRC-16/CCITT)

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
 * @brief Calculate CRC-8 checksum (compliant with CRC-8/ITU standard)
 *
 * Standard parameters:
 *   - Polynomial: 0x07 (i.e., x^8 + x^2 + x + 1)
 *   - Initial value: 0x00
 *   - Input not reflected (RefIn = false)
 *   - Output not reflected (RefOut = false)
 *   - Output XOR value (XorOut): 0x00
 *
 * Suitable for standard CRC-8 applications (e.g., SMBus, ATM HEC)
 *
 * @param data Pointer to the input data
 * @param len  Length of the data in bytes
 * @return uint8_t The calculated CRC-8 value
 */
uint8_t zyzn_crc8(const uint8_t *data, uint16_t len)
{
    uint8_t crc  = 0x00;
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
