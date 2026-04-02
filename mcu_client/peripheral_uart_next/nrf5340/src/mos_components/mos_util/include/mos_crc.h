/*** 
 * @Author       : Cole
 * @Date         : 2025-07-31 11:52:11
 * @LastEditTime : 2025-07-31 16:55:28
 * @FilePath     : mos_crc.h
 * @Description  : 
 * @
 * @ Copyright (c) MentraOS Contributors 2025 
 * @ SPDX-License-Identifier: Apache-2.0
 */

 #ifndef _MOS_CRC_H_
 #define _MOS_CRC_H_



uint16_t mos_crc16_ccitt(uint8_t *ucbuf, uint16_t iLen);

uint8_t zyzn_crc8(const uint8_t *data, uint16_t len);
#endif // _MOS_CRC_H_

