/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_flash.c
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

/*******************************************************************************
* 1.Included files
*******************************************************************************/
#include "./api/cva_tws_api.h"
#include "cva_tws_platform.h"
#include "cva_tws_gesture.h"
#include "cva_tws_flash.h"
#include "cva_tws_util.h"
#include "cva_tws_i2c.h"
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(cva_tws_flash, LOG_LEVEL_INF);
#if CVT213X_FLASH_EN
/*******************************************************************************
* 2.Private constant and macro definitions using #define
*******************************************************************************/

/*******************************************************************************
* 3.Private enumerations, structures and unions using typedef
*******************************************************************************/

/*******************************************************************************
* 4.Static variables
*******************************************************************************/
static cvt_cfg_t g_cali_list_info = {0, {0}, {0}, 0, {0}};
static const TWS_U8  g_diff_thr_numerator[8] = {255, 255, 255, 255, 255, 255, 255, 255};//denominator fix to be 256

static cvt_efuse_cfg_t g_efuse_reg_info = {0,{0},0,{0}};
/*******************************************************************************
* 5.Global variable or extern global variabls/functions
*******************************************************************************/

/*******************************************************************************
* 6.Static function prototypes
*******************************************************************************/

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
static TWS_BOOL cvt213x_cali_list_check_validation(TWS_U8 *cfg_buf, TWS_U16 len)
{
    TWS_U16 i = 0;
    TWS_U8 cfg_cksum = 0;

    //check header
    if (CVT_CFG_HEAD != cfg_buf[0])
    {
        return FALSE;
    }

    //calculate checksum
    for (i = 0; i < len; i ++)
    {
        cfg_cksum ^= cfg_buf[i];
    }

    //check checksum
    if (cfg_cksum)
    {
        return FALSE;
    }
    
    return TRUE;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
static void cvt213x_cali_list_add_header_tail(TWS_U8 *cfg_buf, TWS_U16 len)
{
    TWS_U16 i = 0;
    TWS_U8 cfg_cksum = 0;

    //add header
    cfg_buf[0] = CVT_CFG_HEAD ;

    //calculate checksum
    for (i = 0; i < len - 1; i ++)
    {
        cfg_cksum ^= cfg_buf[i];
    }

    //check checksum
    cfg_buf[i] = cfg_cksum;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_cali_list_get_info_from_flash(void)
{
    TWS_U8 cali_list_buff[16] = {0};

    cvt213x_util_flash_read(cali_list_buff, 16);
    
    cvt213x_util_memcpy(&g_cali_list_info, cali_list_buff, sizeof(g_cali_list_info));
    
    return TRUE;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_cali_list_set_info_to_flash(void)
{
    TWS_U8 cali_list_buff[16] = {0};

    cvt213x_util_memcpy(cali_list_buff, &g_cali_list_info, sizeof(g_cali_list_info));

    cvt213x_util_flash_write(cali_list_buff, 16);
    
    return TRUE;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
static TWS_BOOL cvt213x_efuse_list_get_info_from_flash(void)
{
    TWS_U8 efuse_list_buff[8] = {0};
    cvt213x_util_flash_read(efuse_list_buff, 8);
    cvt213x_util_memcpy(&g_efuse_reg_info, efuse_list_buff, sizeof(g_efuse_reg_info));
    return TRUE;
}
/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
static TWS_BOOL cvt213x_efuse_list_set_info_to_flash(void)
{
    TWS_U8 efuse_list_buff[8] = {0};
    cvt213x_util_memcpy(efuse_list_buff, &g_efuse_reg_info, sizeof(g_efuse_reg_info));
    cvt213x_util_flash_write(efuse_list_buff, 8);
    return TRUE;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_cali_list_get_info_from_trx(TWS_U8 *buff)
{
    TWS_U8 i = 0;

    for (i = 0; i < 3; i ++)
    {
        g_cali_list_info.diff_factor[i] = buff[4 + i];
    }

    for (i = 0; i < 8; i ++)
    {
        g_cali_list_info.diff_th_ph[i] = buff[7 + i];
    }

    cvt213x_cali_list_add_header_tail((TWS_U8 *)&g_cali_list_info, sizeof(g_cali_list_info));
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_efuse_list_get_info_from_register(TWS_U8 *buff)
{
    TWS_U8 i = 0;
    for (i = 0; i < 4; i ++)
    {
        g_efuse_reg_info.efuse_reg[i] = buff[i];
    }
    cvt213x_cali_list_add_header_tail((TWS_U8 *)&g_efuse_reg_info, sizeof(g_efuse_reg_info));
}
/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_cali_list_set_info_to_trx(TWS_U8 *txbuff)
{
    TWS_U8 i = 0;
    
    for (i = 0; i < 3; i ++)
    {
        txbuff[4 + i] = g_cali_list_info.diff_factor[i];
    }

    for (i = 0; i < 8; i ++)
    {
        txbuff[7 + i] = g_cali_list_info.diff_th_ph[i];
    }

    cvt213x_cali_list_add_header_tail((TWS_U8 *)&g_cali_list_info, sizeof(g_cali_list_info));
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_cali_list_get_info_from_register(tws_reg_t *reg_default)
{
    TWS_U8 rd_data[4] = {0};
    TWS_U32 diff_factor = 0;
    TWS_U8 i = 0;

    g_cali_list_info.diff_factor[0] = 0;
    g_cali_list_info.diff_factor[1] = 0;
    g_cali_list_info.diff_factor[2] = 0;

    for (i = 0; i < 8; i ++)
    {
        TWS_U8 temp = 0;
        
        //get diff_th_factor&proximity threshold from register
        cvt213x_util_i2c_read(CVT213X_TRX_SLE, reg_default[i].reg, rd_data, 2);

        //update diff_th_factor to cali-list
        temp         = (TWS_U8)(rd_data[1]) & 0x07;
        diff_factor |= (temp << (3 * i)) ;

        //update proximity threshold to cali-list
        g_cali_list_info.diff_th_ph[i] = rd_data[0];
    }

    g_cali_list_info.diff_factor[0] = CVT213X_ULTI_GET_LOW_BYTE_FROM_DWORD(diff_factor);
    g_cali_list_info.diff_factor[1] = CVT213X_ULTI_GET_MIDDLE_BYTE_FROM_DWORD(diff_factor);
    g_cali_list_info.diff_factor[2] = CVT213X_ULTI_GET_HIGH_BYTE_FROM_DWORD(diff_factor);

    return TRUE;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_cali_list_set_info_to_register(tws_reg_t *reg_default)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_cali_list_set_info_to_register() enter");

    cvt213x_cali_list_get_info_from_flash();

    if (cvt213x_cali_list_check_validation((TWS_U8 *)&g_cali_list_info, sizeof(g_cali_list_info)))
    {
        TWS_U32 diff_factor = CVT213X_ULTI_COMBINE_BYTES_TO_DWORD(g_cali_list_info.diff_factor[0], g_cali_list_info.diff_factor[1], g_cali_list_info.diff_factor[2]);
    
        TWS_U8 temp_factor;
        TWS_U32 temp_thr;
        TWS_U8 i = 0;
        
        for (i = 0; i < 8; i ++)
        {
            //get diff_th_factor from cali-list
            temp_factor = (diff_factor >> (3 * i)) & 0x07;

            //get proximity threshold from cali-list and config array
            temp_thr    = (TWS_U32)g_cali_list_info.diff_th_ph[i] * (TWS_U32)(g_diff_thr_numerator[i] + 1);
            temp_thr    = temp_thr >> 8;

            //update PROC_DIFF register config
            reg_default[i].val &= 0xfff000;
            reg_default[i].val |= (temp_thr | ((TWS_U32)temp_factor << 8)); 
        #if CVT213X_SETUP_FUN
            if (i == 3)
            {
                TWS_U32 thr = temp_thr * temp_thr;
                thr <<= temp_factor;
                thr >>= 1;
                cvt213x_setup_update_ph3_thr(thr);
            }
            else if (i == 4)
            {
                TWS_U32 thr = temp_thr * temp_thr;
                thr <<= temp_factor;
                thr >>= 1;
                cvt213x_setup_update_ph4_thr(thr);
            }
        #endif
        }
        CVT213X_LIB_LOG_D(0, " get cali-list ok");

        return TRUE;
    }
    else
    {
        CVT213X_LIB_LOG_D(0, " get cali-list ng");
        return FALSE;
    }
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_efuse_list_set_info_to_register(TWS_U8 *buff)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_efuse_list_set_info_to_register() enter");
    cvt213x_efuse_list_get_info_from_flash();
    if (cvt213x_cali_list_check_validation((TWS_U8 *)&g_efuse_reg_info, sizeof(g_efuse_reg_info)))
    {
        CVT213X_LIB_LOG_D(4,"get efuse_reg :0x%02x,0x%02x,0x%02x,0x%02x",g_efuse_reg_info.efuse_reg[0],g_efuse_reg_info.efuse_reg[1],g_efuse_reg_info.efuse_reg[2],g_efuse_reg_info.efuse_reg[3]);
        TWS_U8 i =0;
        for(i=0;i<4;i++)
        {
            buff[i] = g_efuse_reg_info.efuse_reg[i];
        }
        CVT213X_LIB_LOG_D(0, " get efuse-list ok");

        return TRUE;
    }
    else
    {
        CVT213X_LIB_LOG_D(0, " get efuse-list ng");
        return FALSE;
    }
}
/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_cali_list_write_to_flash_and_all_reset(void)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_cali_list_write_to_flash_and_all_reset() enter");

    //write cali-list to flash
    cvt213x_cali_list_set_info_to_flash();

    cvt213x_scan_mode_switch(CVT213X_TRX_SLE, NULL_MODE, DEFAULT_MODE);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_efuse_list_write_to_flash(void)
{
    cvt213x_efuse_list_set_info_to_flash();
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
#include "string.h"
TWS_BOOL cvt213x_cali_list_get_flash_data_check(void)
{
    if (cvt213x_cali_list_check_validation((TWS_U8 *)&g_cali_list_info, sizeof(g_cali_list_info)))
    {
        return TRUE;
    }
    else
    {
		memset(&g_cali_list_info,0,sizeof(g_cali_list_info));
        return FALSE;
    }
}
#endif

