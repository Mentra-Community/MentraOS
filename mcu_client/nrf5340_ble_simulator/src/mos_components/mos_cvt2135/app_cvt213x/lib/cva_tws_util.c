/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_util.c
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

/*******************************************************************************
* 1.Included header files
*******************************************************************************/
#include "./api/cva_tws_api.h"
#include "cva_tws_util.h"
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(cva_tws_util, LOG_LEVEL_INF);
/*******************************************************************************
* 2.Private constant and macro definitions using #define
*******************************************************************************/

/*******************************************************************************
* 3.Private enumerations, structures and unions using typedef
*******************************************************************************/
typedef struct
{
    tws_delay_cb      tws_Delay_f;
    
    cvt213x_i2c_cb    tws_I2c_Write_f;
    cvt213x_i2c_cb    tws_I2c_Read_f;
    tws_get_current_ms tws_get_current_ms_f;
    tws_irq_get_level tws_irq_get_level_f;
#if CVT213X_FLASH_EN
    tws_flash_write   tws_flash_write_f;
    tws_flash_read    tws_flash_read_f;
    tws_setup_flash_write   tws_setup_flash_write_f;
    tws_setup_flash_read    tws_setup_flash_read_f;
#endif
#if CVT213X_TRX_EN
    tws_trx_tx        tws_TRX_TX_f[TWS_TRX_PORT_MAX_NUM];
#endif
} tws_cb_t;

/*******************************************************************************
* 4.Static variables
*******************************************************************************/
static const tws_cb_t g_tws_cb = 
{
    .tws_Delay_f = app_cvt213x_delay,
    .tws_I2c_Write_f = app_cvt213x_i2c_write_reg,
    .tws_I2c_Read_f = app_cvt213x_i2c_read_reg,
    .tws_get_current_ms_f = app_cvt213x_get_current_timer,
    .tws_irq_get_level_f = app_cvt231x_irq_get_leavel,
#if CVT213X_FLASH_EN
    .tws_flash_write_f = app_cvt231x_flash_write,
    .tws_flash_read_f = app_cvt231x_flash_read,
    .tws_setup_flash_write_f = app_cvt231x_setup_flash_write,
    .tws_setup_flash_read_f = app_cvt231x_setup_flash_read,
#endif
#if CVT213X_TRX_EN
    .tws_TRX_TX_f = {app_cvt213x_trx_spp_tx, app_cvt213x_trx_uart_tx},
#endif
};

#if CVT213X_TRX_EN
static enum_tws_trx_port_e g_cvt213x_trx_port = TWS_TRX_PORT_SPP;
#endif
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
TWS_S8 cvt213x_util_delay(TWS_U32 Delay)
{
    g_tws_cb.tws_Delay_f(Delay);
    return TWS_RET_OK;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_S8 cvt213x_util_i2c_write(tws_chip_index_e chipIndex, TWS_U16 addr, TWS_U8 *buff, TWS_U32 size)
{
    g_tws_cb.tws_I2c_Write_f(chipIndex, addr, buff, size);
    return TWS_RET_OK;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_S8 cvt213x_util_i2c_read(tws_chip_index_e chipIndex, TWS_U16 addr, TWS_U8 *buff, TWS_U32 size)
{
    g_tws_cb.tws_I2c_Read_f(chipIndex, addr, buff, size);
    return TWS_RET_OK;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_U32 cvt213x_util_get_current_timer(void)
{
    return g_tws_cb.tws_get_current_ms_f();;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_S8 cvt213x_util_irq_get_level(tws_chip_index_e chipIndex)
{
    return g_tws_cb.tws_irq_get_level_f(chipIndex);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
#if CVT213X_FLASH_EN
TWS_S8 cvt213x_util_flash_write(TWS_U8 buf[], TWS_U8 len)
{
    return g_tws_cb.tws_flash_write_f(buf, len);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_S8 cvt213x_util_flash_read(TWS_U8 buf[], TWS_U8 len)
{
    return g_tws_cb.tws_flash_read_f(buf, len);
}
/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_S8 cvt213x_util_setup_flash_write(TWS_U8 buf[], TWS_U8 len)
{
    return g_tws_cb.tws_setup_flash_write_f(buf, len);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_S8 cvt213x_util_setup_flash_read(TWS_U8 buf[], TWS_U8 len)
{
    return g_tws_cb.tws_setup_flash_read_f(buf, len);
}
#endif

#if CVT213X_TRX_EN
void cvt213x_util_trx_set_tx_port(enum_tws_trx_port_e port)
{
    g_cvt213x_trx_port = port;
}
#endif
/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
#if CVT213X_TRX_EN
TWS_S8 cvt213x_util_trx_tx(TWS_U8 *packet, TWS_U16 len)
{
    return g_tws_cb.tws_TRX_TX_f[g_cvt213x_trx_port](packet, len);
}
#endif
/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_util_wait_eint(tws_chip_index_e chipIndex, TWS_U32 time_out_ms)
{
    TWS_U16 i = 0;

    while (cvt213x_util_irq_get_level(chipIndex))
    {
        cvt213x_util_delay(1);
        i++;
        if (i > (time_out_ms * 2))
        {
            return FALSE;
        }
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
TWS_S8 cvt213x_util_i2c_write_dword(tws_chip_index_e chipIndex, TWS_U16 addr, TWS_U32 value)
{
    TWS_U8 buf[4] = {0};
    
    buf[0] = value & 0xFF;
    buf[1] = (value >> 8) & 0xFF;
    buf[2] = (value >> 16) & 0xFF;
    buf[3] = (value >> 24) & 0xFF;

    g_tws_cb.tws_I2c_Write_f(chipIndex, addr, buf, 4);
    
    return TWS_RET_OK;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_S8 cvt213x_util_i2c_read_dword(tws_chip_index_e chipIndex, TWS_U16 addr, TWS_U32 *value)
{
    TWS_U8 buff[4] = {0};
    
    g_tws_cb.tws_I2c_Read_f(chipIndex, addr, buff, 4);

    *value  = (buff[3] << 24) + (buff[2] << 16) + (buff[1] << 8) + (buff[0]);

    return TWS_RET_OK;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void *cvt213x_util_memcpy(void *dst, const void *src, TWS_U16 len)
{
    TWS_S8 *pdst = (TWS_S8 *)dst;
    TWS_S8 *psrc = (TWS_S8 *)src;

    if ((dst == NULL) || (src == NULL) || (len == 0))
    {
        return NULL;
    }

    if (pdst > psrc && pdst < psrc + len)
    {
        pdst = pdst + len - 1;
        psrc = psrc + len - 1;
        while (len--)
        {
            *pdst-- = *psrc--;
        }
    }
    else
    {
        while (len--)
        {
            *pdst++ = *psrc++;
        }
    }
    
    return dst;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_util_memset(TWS_S32 dst[], TWS_S32 value, TWS_U8 len)
{
    TWS_U8 index = 0;

    for (index = 0; index < len; index++)
    {
        dst[index] = value;
    }
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_util_buf_push(TWS_S32 dst[], TWS_S32 value, TWS_U8 len)
{
    TWS_U8 index = 0;

    for (index = 0; index < len - 1; index++)
    {
        dst[index] = dst[index + 1];
    }
    dst[index] = value;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_U32 cvt213x_transfer_data_to_reg(TWS_S32 value)
{
    TWS_U32 temp = 0;

    if (value < 0)
    {
        temp = value + 0x00200000;
        temp &= 0x001fffff;
    }
    else
    {
        temp = value;
    }

    return temp;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_S32 cvt213x_transfer_reg_to_data(TWS_U32 reg)
{
    TWS_S32 temp = 0;

    if (reg & 0x00100000)
    {
        temp = (reg & 0x001fffff) - 0x00200000;
    }
    else
    {
        temp = reg;
    }
  
    return temp;
}

