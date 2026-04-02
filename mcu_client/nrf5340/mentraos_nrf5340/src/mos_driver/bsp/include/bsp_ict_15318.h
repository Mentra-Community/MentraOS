/*** 
 * @Author       : XK
 * @Date         : 2025-07-09 12:30:39
 * @LastEditTime : 2025-07-15 16:26:10
 * @FilePath     : bsp_ict_15318.h
 * @Description  : 
 * @
 * @Copyright (c) XingYiZhiNeng 2025 , All Rights Reserved. 
 */

#ifndef _BSP_ICT_15318_H_
#define _BSP_ICT_15318_H_

#include "bsp_log.h"


#define ICT_15318_REG_MANU_ID   0x00 // Manufacturer ID 寄存器地址
#define ICT_15318_REG_CHIP_ID   0x01 // Chip ID 寄存器地址
#define ICT_15318_I2C_ADDR      0x1E


int bsp_ict_15318_iic_init(void);

bool bsp_ict_15318_write(uint8_t Write_Reg_Addr, uint8_t DataToWrite);

bool bsp_ict_15318_read(uint8_t Read_Reg_Addr, uint8_t *DataToRead);
#endif /* _BSP_ICT_15318_H_ */
