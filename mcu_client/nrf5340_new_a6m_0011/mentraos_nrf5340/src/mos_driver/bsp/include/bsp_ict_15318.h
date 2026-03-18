/***
 * @Author       : Cole
 * @Date         : 2025-07-31 11:52:17
 * @LastEditTime : 2025-07-31 17:02:44
 * @FilePath     : bsp_ict_15318.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef _BSP_ICT_15318_H_
#define _BSP_ICT_15318_H_

#define ICT_15318_REG_MANU_ID 0x00  // Manufacturer ID 寄存器地址; Manufacturer ID register address
#define ICT_15318_REG_CHIP_ID 0x01  // Chip ID 寄存器地址; Chip ID register address
#define ICT_15318_I2C_ADDR    0x1E

int bsp_ict_15318_iic_init(void);

bool bsp_ict_15318_write(uint8_t Write_Reg_Addr, uint8_t DataToWrite);

bool bsp_ict_15318_read(uint8_t Read_Reg_Addr, uint8_t *DataToRead);
#endif /* _BSP_ICT_15318_H_ */
