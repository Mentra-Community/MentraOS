/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_flash.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

#ifndef _CVA_TWS_FLASH_H_
#define _CVA_TWS_FLASH_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
* 1.Included files
*******************************************************************************/
#if CVT213X_FLASH_EN
/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/
#define  CVT_CFG_HEAD       (0x7A)

/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/
typedef struct
{
    TWS_U8  cfg_head;

    TWS_U8  diff_factor[3];

    TWS_U8  diff_th_ph[8];

    TWS_U8  cfg_cksum;
    
    TWS_U8  cfg_res[1];  //reserved for assignment
} cvt_cfg_t;

typedef struct
{
    TWS_U8 efuse_cfg_head;
    TWS_U8 efuse_reg[4];
    TWS_U8 efuse_cfg_cksum;
    TWS_U8 efuse_res[1];    //reserved for assignment
} cvt_efuse_cfg_t;
/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/

/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/
TWS_BOOL cvt213x_cali_list_get_info_from_flash(void);
TWS_BOOL cvt213x_cali_list_set_info_to_flash(void);
void cvt213x_cali_list_get_info_from_trx(TWS_U8 *buff);
void cvt213x_cali_list_set_info_to_trx(TWS_U8 *txbuff);
TWS_BOOL cvt213x_cali_list_get_info_from_register(tws_reg_t *reg_default);
TWS_BOOL cvt213x_cali_list_set_info_to_register(tws_reg_t *reg_default);
TWS_BOOL cvt213x_efuse_list_set_info_to_register(TWS_U8 *buff);
void cvt213x_efuse_list_get_info_from_register(TWS_U8 *buff);
void cvt213x_cali_list_write_to_flash_and_all_reset(void);
void cvt213x_efuse_list_write_to_flash(void);
TWS_BOOL cvt213x_cali_list_get_flash_data_check(void);
#endif
#ifdef __cplusplus
}
#endif

#endif

