/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_util.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/
#ifndef _CVA_TWS_UTIL_H_
#define _CVA_TWS_UTIL_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
* 1.Included files
*******************************************************************************/

/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/
#define CVT213X_ULTI_GET_LOW_BYTE_FROM_DWORD(word)  ((TWS_U32)(word) & 0x00FF)
#define CVT213X_ULTI_GET_MIDDLE_BYTE_FROM_DWORD(word) (((TWS_U32)(word) >> 8) & 0x00FF)
#define CVT213X_ULTI_GET_HIGH_BYTE_FROM_DWORD(word) (((TWS_U32)(word) >> 16) & 0x00FF)

#define CVT213X_ULTI_COMBINE_BYTES_TO_DWORD(low, middle, high) ((TWS_U32)(low)| ((TWS_U32)(middle)<<8) | ((TWS_U32)(high)<<16))

/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/

/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/

/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/
TWS_S8 cvt213x_util_delay(TWS_U32 Delay);
TWS_S8 cvt213x_util_i2c_write(tws_chip_index_e chipIndex, TWS_U16 addr, TWS_U8 *buff, TWS_U32 size);
TWS_S8 cvt213x_util_i2c_read(tws_chip_index_e chipIndex, TWS_U16 addr, TWS_U8 *buff, TWS_U32 size);
TWS_U32 cvt213x_util_get_current_timer(void);
TWS_S8 cvt213x_util_irq_get_level(tws_chip_index_e chipIndex);
TWS_S8 cvt213x_util_flash_write(TWS_U8 buf[], TWS_U8 len);
TWS_S8 cvt213x_util_flash_read(TWS_U8 buf[], TWS_U8 len);
TWS_S8 cvt213x_util_setup_flash_write(TWS_U8 buf[], TWS_U8 len);
TWS_S8 cvt213x_util_setup_flash_read(TWS_U8 buf[], TWS_U8 len);
TWS_S8 cvt213x_util_trx_tx(TWS_U8 *packet, TWS_U16 len);
TWS_BOOL cvt213x_util_wait_eint(tws_chip_index_e chipIndex, TWS_U32 time_out_ms);
TWS_S8 cvt213x_util_i2c_write_dword(tws_chip_index_e chipIndex, TWS_U16 addr, TWS_U32 value);
TWS_S8 cvt213x_util_i2c_read_dword(tws_chip_index_e chipIndex, TWS_U16 addr, TWS_U32 *value);
void *cvt213x_util_memcpy(void *dst, const void *src, TWS_U16 len);
void cvt213x_util_memset(TWS_S32 dst[], TWS_S32 value, TWS_U8 len);
void cvt213x_util_buf_push(TWS_S32 dst[], TWS_S32 value, TWS_U8 len);

TWS_U32 cvt213x_transfer_data_to_reg(TWS_S32 value);
TWS_S32 cvt213x_transfer_reg_to_data(TWS_U32 reg);
#ifdef __cplusplus
}
#endif

#endif

