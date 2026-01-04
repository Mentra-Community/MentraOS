/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_i2c.c
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

/*******************************************************************************
* 1.Included header files
*******************************************************************************/
#include "./api/cva_tws_api.h"
#include "cva_tws_i2c.h"
#include "cva_tws_flash.h"
#include "cva_tws_platform.h"
#include "cva_tws_util.h"
#include "cva_tws_gesture.h"
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(cva_tws_i2c, LOG_LEVEL_INF);
/*******************************************************************************
* 2.Private constant and macro definitions using #define
*******************************************************************************/

/*******************************************************************************
* 3.Private enumerations, structures and unions using typedef
*******************************************************************************/

/*******************************************************************************
* 4.Static variables
*******************************************************************************/
static const tws_reg_t g_reg_default[TWS_CHIP_NUM][REG_DEFAULT_NUM] =
{
    REG_DEFAULT,
#if DUAL_CVT213X_ENABLE
    REG_DEFAULT_2ND
#endif
};

static const tws_reg_t g_reg_init[TWS_CHIP_NUM][REG_INIT_NUM] = 
{
    REG_INIT, 
#if DUAL_CVT213X_ENABLE
    REG_INIT_2ND
#endif
};

static const tws_reg_t g_reg_doze[TWS_CHIP_NUM][REG_DOZE_NUM] = 
{
    REG_DOZE, 
#if DUAL_CVT213X_ENABLE
    REG_DOZE_2ND
#endif
};

#if CVT213X_HOST_SLEEP_EN
static const tws_reg_t g_reg_host_sleep[TWS_CHIP_NUM][REG_HOST_SLEEP_NUM] =
{
    REG_HOST_SLEEP, 
#if DUAL_CVT213X_ENABLE
    REG_HOST_SLEEP_2ND
#endif
};
static const tws_reg_t g_reg_host_wakeup[TWS_CHIP_NUM][REG_HOST_WAKEUP_NUM] =
{
    REG_HOST_WAKEUP, 
#if DUAL_CVT213X_ENABLE
    REG_HOST_WAKEUP_2ND
#endif
};
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
void  cvt213x_i2c_send_cmd(tws_chip_index_e chipIndex, const enum_tws_cmd_e cmd)
{
    switch (cmd)
    {
    case TWS_CMD_START:                //开启扫描
        cvt213x_util_i2c_write_dword(chipIndex, FSM_CMD, 0x0054185F);
        break;

    case TWS_CMD_COMP:                //开启校准
        cvt213x_util_i2c_write_dword(chipIndex, FSM_CMD, 0x0054185E);
        break;

    case TWS_CMD_ENTER_SLEEP:         //进入休眠
        cvt213x_util_i2c_write_dword(chipIndex, FSM_CMD, 0x0054185D);
        break;

    case TWS_CMD_EXITS_SLEEP:         //退出休眠
        cvt213x_util_i2c_write_dword(chipIndex, FSM_CMD, 0x0054185C);
        cvt213x_util_delay(10);
        break;

    case TWS_CMD_IDLE:                //进入Idle mode
        cvt213x_util_i2c_write_dword(chipIndex, FSM_CMD, 0x0054185B);
        cvt213x_util_delay(1);
        break;

    case TWS_CMD_SCAN:                //恢复扫描
        cvt213x_util_i2c_write_dword(chipIndex, FSM_CMD, 0x0054185A);
        break;

    case TWS_CMD_RESET:                //复位
    {
        TWS_U8 reset_cmd = 0x01;
        cvt213x_util_i2c_write(chipIndex, CHIP_RESET, &reset_cmd, 1);
        cvt213x_util_delay(5);
    }
        break;

    default:
        break;
    }
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void  cvt213x_i2c_clear_int(tws_chip_index_e chipIndex)
{
    TWS_U8 buf[2] = {0xFF, 0xFF};
    cvt213x_util_i2c_write(chipIndex, FSM_IRQ, buf, 2);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void  cvt213x_i2c_read_irq(tws_chip_index_e chipIndex, TWS_U8 *rd_data)
{
    cvt213x_util_i2c_read(chipIndex, FSM_IRQ, rd_data, 2);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void  cvt213x_i2c_read_touch_state(tws_chip_index_e chipIndex, TWS_U8 *rd_data)
{
    cvt213x_util_i2c_read(chipIndex, FSM_STAT0, rd_data, 1);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
static void cvt213x_i2c_load_default_reg(tws_chip_index_e chipIndex)
{
    TWS_U8 index = 0;
#if CVT213X_FLASH_EN
    tws_reg_t reg_cali[] =
    {
        { CVT213X_PROC_DIFF_PH0,    PH0_THRE | (PH0_FACT << 8) | (PH0_CLOSEDEB << 16) | (PH0_FARDEB << 18)},\
        { CVT213X_PROC_DIFF_PH1,    PH1_THRE | (PH1_FACT << 8) | (PH1_CLOSEDEB << 16) | (PH1_FARDEB << 18)},\
        { CVT213X_PROC_DIFF_PH2,    PH2_THRE | (PH2_FACT << 8) | (PH2_CLOSEDEB << 16) | (PH2_FARDEB << 18)},\
        { CVT213X_PROC_DIFF_PH3,    PH3_THRE | (PH3_FACT << 8) | (PH3_CLOSEDEB << 16) | (PH3_FARDEB << 18)},\
        { CVT213X_PROC_DIFF_PH4,    PH4_THRE | (PH4_FACT << 8) | (PH4_CLOSEDEB << 16) | (PH4_FARDEB << 18)},\
        { CVT213X_PROC_DIFF_PH5,    PH5_THRE | (PH5_FACT << 8) | (PH5_CLOSEDEB << 16) | (PH5_FARDEB << 18)},\
        { CVT213X_PROC_DIFF_PH6,    PH6_THRE | (PH6_FACT << 8) | (PH6_CLOSEDEB << 16) | (PH6_FARDEB << 18)},\
        { CVT213X_PROC_DIFF_PH7,    PH7_THRE | (PH7_FACT << 8) | (PH7_CLOSEDEB << 16) | (PH7_FARDEB << 18)}
    };
#endif
    CVT213X_LIB_LOG_D(0, "cvt213x_i2c_load_default_reg() enter");

    //clean irq
    cvt213x_i2c_clear_int(chipIndex);
    
    //MPX config
    cvt213x_util_i2c_write_dword(chipIndex, AFEC_MPX, 0x00000003);

    //CLOCK config
    cvt213x_util_i2c_write_dword(chipIndex, IP_CLK_EN, 0x0000001F);

    for (index = 1; index < (g_reg_default[chipIndex][0].val & 0xFF); index++)
    {
        cvt213x_util_i2c_write_dword(chipIndex, g_reg_default[chipIndex][index].reg, g_reg_default[chipIndex][index].val);
    }
#if CVT213X_FLASH_EN
    //update PROC_DIFF register config
    if (cvt213x_cali_list_set_info_to_register(reg_cali) == TRUE)
    {
        for (index = 0; index < 8; index++)
        {
            cvt213x_util_i2c_write_dword(chipIndex, reg_cali[index].reg, reg_cali[index].val);
        }
    }
#endif
#if CVT213X_SETUP_FUN
    cvt213x_ied_set_last_prox_state(0x00);
    if (!cvt213x_is_earphone_in_box_state_get())//获取耳机在盒内状态，1 inbox  0 outbox
    {
        cvt213x_setup_detect(chipIndex);
    }
#endif
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
static void cvt213x_i2c_load_init_reg(tws_chip_index_e chipIndex)
{
    TWS_U8 index = 0;

    CVT213X_LIB_LOG_D(0, "cvt213x_i2c_load_init_reg() enter");

    for (index = 1; index < (g_reg_init[chipIndex][0].val & 0xFF); index++)
    {
        cvt213x_util_i2c_write_dword(chipIndex, g_reg_init[chipIndex][index].reg, g_reg_init[chipIndex][index].val);
    }
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
static void cvt213x_i2c_load_doze_reg(tws_chip_index_e chipIndex)
{
    TWS_U8 index = 0;

    CVT213X_LIB_LOG_D(0, "cvt213x_i2c_load_doze_reg() enter");

    for (index = 1; index < (g_reg_doze[chipIndex][0].val & 0xFF); index++)
    {
        cvt213x_util_i2c_write_dword(chipIndex, g_reg_doze[chipIndex][index].reg, g_reg_doze[chipIndex][index].val);
    }
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
static void cvt213x_i2c_load_host_sleep_reg(tws_chip_index_e chipIndex)
{
    CVT213X_UNUSED(chipIndex);
#if CVT213X_HOST_SLEEP_EN
    TWS_U8 index = 0;

    CVT213X_LIB_LOG_D(0, "cvt213x_i2c_load_host_sleep_reg() enter");

    for (index = 1; index < (g_reg_host_sleep[chipIndex][0].val & 0xFF); index++)
    {
        cvt213x_util_i2c_write_dword(chipIndex, g_reg_host_sleep[chipIndex][index].reg, g_reg_host_sleep[chipIndex][index].val);
    }
#if 1
    {
        TWS_U8 wr_data[4] = {0};

        cvt213x_util_i2c_read(chipIndex, PMU_TRIM0, wr_data, 4);
        CVT213X_LIB_LOG_E(4, "PMU_TRIM0 origin:0x%02x 0x%02x 0x%02x 0x%02x\n", wr_data[0], wr_data[1], wr_data[2], wr_data[3]);
#if 0
        //save efuse into flash
        cvt213x_efuse_list_get_info_from_register(wr_data);
        cvt213x_efuse_list_write_to_flash();
#endif
        //da_osc10m_trim12  配置最小挡位，4M最慢  bit11~bit16
        wr_data[1] = (wr_data[1] & 0x07) | 0x00;
        wr_data[2] = (wr_data[2] & 0xFE) | 0x00;
        // //da_r32k_trim12 配置最大挡位，32k最慢  bit17~bit24
        // wr_data[2] = (wr_data[2] & 0x01) | 0xFE;
        // wr_data[3] = (wr_data[3] & 0xFE) | 0x01;

        /********************************da_ldo12_trim12****************************************************/
        wr_data[0] = (wr_data[0] & 0x3f) | 0x00;
        wr_data[1] = (wr_data[1] & 0xFE) | 0x00;

        /********************************da_bg_trim12****************************************************/
        // wr_data[0] = (wr_data[0] & 0xC1) | 0x24;
        wr_data[0] = (wr_data[0] & 0xC1) | 0x14;

        cvt213x_util_i2c_write(chipIndex, PMU_TRIM0, wr_data, 4);
        CVT213X_LIB_LOG_E(4, "PMU_TRIM0 write:0x%02x 0x%02x 0x%02x 0x%02x\n", wr_data[0], wr_data[1], wr_data[2], wr_data[3]);
        cvt213x_util_delay(5);

        cvt213x_util_i2c_read(chipIndex, PMU_TRIM0, wr_data, 4);
        CVT213X_LIB_LOG_E(4, "PMU_TRIM0 read:0x%02x 0x%02x 0x%02x 0x%02x\n", wr_data[0], wr_data[1], wr_data[2], wr_data[3]);
    }
#endif
#endif
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
static void cvt213x_i2c_load_host_wakeup_reg(tws_chip_index_e chipIndex)
{
    CVT213X_UNUSED(chipIndex);
#if CVT213X_HOST_SLEEP_EN
    TWS_U8 index = 0;
    CVT213X_LIB_LOG_D(0, "cvt213x_i2c_load_host_wakeup_reg() enter");
    for (index = 1; index < (g_reg_host_wakeup[chipIndex][0].val & 0xFF); index++)
    {
        cvt213x_util_i2c_write_dword(chipIndex, g_reg_host_wakeup[chipIndex][index].reg, g_reg_host_wakeup[chipIndex][index].val);
    }
#endif
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_i2c_load_reg(tws_chip_index_e chipIndex, const enum_scan_mode mode)
{
    switch (mode)
    {
    case DEFAULT_MODE:
    {
        cvt213x_i2c_load_default_reg(chipIndex);                         //default mode，开机后校准的寄存器初始化
        break;
    }
    case INIT_MODE:
    {
        cvt213x_i2c_load_init_reg(chipIndex);                            //init mode，校准后进行抛帧，打开avg filter
        break;
    }
    case DOZE_MODE:
    {
        cvt213x_i2c_load_doze_reg(chipIndex);                            //doze mode，进行触摸判断
        break;
    }
    case HOST_SLEEP_MODE:
    {
        cvt213x_i2c_load_host_sleep_reg(chipIndex);                      //host-sleep mode
        break;
    }
    case HOST_WAKEUP_MODE:
    {
        cvt213x_i2c_load_host_wakeup_reg(chipIndex);                     //host-wakeup mode
        break;
    }
    default:
    {
        break;
    }
    }
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
tws_ret_e cvt213x_i2c_reset(tws_chip_index_e chipIndex)
{
    TWS_U8 rd_irq[2] = {0};
    TWS_U8 index = 0;

    CVT213X_LIB_LOG_D(0, "cvt213x_i2c_reset() enter");

    cvt213x_i2c_clear_int(chipIndex);
    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_EXITS_SLEEP);

    cvt213x_i2c_clear_int(chipIndex);
    CVT213X_LIB_LOG_E(2,"chip%d:clear int, int level = %d",chipIndex, cvt213x_util_irq_get_level(chipIndex));
    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_RESET);

    cvt213x_i2c_read_irq(chipIndex, rd_irq);
    CVT213X_LIB_LOG_E(2, "chip%d:reset, irq[0] = 0x%x,int level = %d",chipIndex, rd_irq[0], cvt213x_util_irq_get_level(chipIndex));

    while (rd_irq[0] != TWS_IRQ_READY) //check idle
    {     
        cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_RESET);
        
        cvt213x_i2c_read_irq(chipIndex, rd_irq);
        CVT213X_LIB_LOG_D(1, "cvt213x reset fail,please check!!! 0x%x\n", rd_irq[0]);

        if ((index++) > 5) //retry times
        {
            return TWS_RET_TIME_OUT;
        }
    }

    return TWS_RET_OK;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_i2c_mp_init(tws_chip_index_e chipIndex)
{
    TWS_U8 index = 0;
    TWS_U32 ctrl0_config = 0;
    TWS_U32 ctrl1_config = 0;

    CVT213X_LIB_LOG_D(0, "cvt213x_i2c_mp_init() enter");

    cvt213x_util_i2c_write_dword(chipIndex, FSM_IRQNEN, TWS_IRQ_CONVDONE);

    //find ctrl0 & ctrl1 config
    for (index = 1; index < (g_reg_default[chipIndex][0].val & 0xFF); index++)
    {
        if (g_reg_default[chipIndex][index].reg == FSM_CTRL0)
        {
            ctrl0_config = g_reg_default[chipIndex][index].val;
        }
        
        if (g_reg_default[chipIndex][index].reg == FSM_CTRL1)
        {
            ctrl1_config = g_reg_default[chipIndex][index].val;
        }
    }

    //fix scan-peroid to be highest
    cvt213x_util_i2c_write_dword(chipIndex, FSM_CTRL0, ctrl0_config);

    //fix compen to be 0
    cvt213x_util_i2c_write_dword(chipIndex, FSM_CTRL1, ctrl1_config & 0xFFFFFF00U);

    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_SCAN);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
// TWS_U8 cvt213x_i2c_is_touch_release(tws_chip_index_e chipIndex)
// {
//     TWS_U8 proximity_state[4] = {0};
//     CVT213X_LIB_LOG_W(1, "proximity_state[0]:0x%02x", proximity_state[0]);

//     cvt213x_i2c_read_touch_state(chipIndex, proximity_state);
    
// #if (CVT213X_IC_TYPE_SELECT != IC_TYPE_CVT2138)
//     if ((proximity_state[0] & (TWS_STAT_PH0 | TWS_STAT_PH1 | TWS_STAT_PH2)) == 0x00)
// #else
//     if ((proximity_state[0] & (TWS_STAT_PH5 | TWS_STAT_PH6 | TWS_STAT_PH7)) == 0x00)
// #endif
//     {
//         return TRUE;
//     }

//     return FALSE;
// }
