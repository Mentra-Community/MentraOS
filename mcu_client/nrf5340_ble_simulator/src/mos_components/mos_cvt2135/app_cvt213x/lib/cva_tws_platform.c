/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_platform.c
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

/*******************************************************************************
* 1.Included header files
*******************************************************************************/
#include "./api/cva_tws_api.h"
#include "cva_tws_platform.h"
#include "cva_tws_i2c.h"
#include "cva_tws_gesture.h"
#include "cva_tws_util.h"
#include "cva_tws_dongle.h"
#include "cva_tws_flash.h"
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(cva_tws_platform, LOG_LEVEL_INF);
/*******************************************************************************
* 2.Private constant and macro definitions using #define
*******************************************************************************/

/*******************************************************************************
* 3.Private enumerations, structures and unions using typedef
*******************************************************************************/

/*******************************************************************************
* 4.Static variables
*******************************************************************************/
static tws_work_status_e g_cvt213x_init_flag[TWS_CHIP_NUM] = 
{
    CVT_POWER_ON, 
#if DUAL_CVT213X_ENABLE
    CVT_POWER_ON
#endif
};

static st_scan_mode_t g_cvt213x_scan_mode[TWS_CHIP_NUM] =
{
    {NULL_MODE, NULL_MODE}, 
#if DUAL_CVT213X_ENABLE
    {NULL_MODE, NULL_MODE}
#endif
};

TWS_U8 g_cvt213x_init_state[TWS_CHIP_NUM] =
{
    0,  //0:far, 1:close
#if DUAL_CVT213X_ENABLE
    0,
#endif
};
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
void cvt213x_set_init_state(tws_chip_index_e chipIndex, TWS_U8 status)
{
    g_cvt213x_init_state[chipIndex] = status;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_U8 cvt213x_get_init_state(tws_chip_index_e chipIndex)
{
    return g_cvt213x_init_state[chipIndex];
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_util_set_init_flag(tws_chip_index_e chipIndex, tws_work_status_e status)
{
    g_cvt213x_init_flag[chipIndex] = status;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
tws_work_status_e cvt213x_util_get_init_flag(tws_chip_index_e chipIndex)
{
    return g_cvt213x_init_flag[chipIndex];
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_scan_mode_init(tws_chip_index_e chipIndex)
{
    g_cvt213x_scan_mode[chipIndex].scan_mode = NULL_MODE;
    g_cvt213x_scan_mode[chipIndex].scan_mode_next = NULL_MODE;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
enum_scan_mode cvt213x_get_scan_mode(tws_chip_index_e chipIndex)
{
    return g_cvt213x_scan_mode[chipIndex].scan_mode;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
enum_scan_mode cvt213x_get_next_scan_mode(tws_chip_index_e chipIndex)
{
    return g_cvt213x_scan_mode[chipIndex].scan_mode_next;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_scan_mode_prepare_switch(tws_chip_index_e chipIndex, enum_scan_mode new_mode)
{
    CVT213X_LIB_LOG_D(1, "cvt213x_scan_mode_prepare_switch to new mode(%d)", new_mode);

    g_cvt213x_scan_mode[chipIndex].scan_mode_next = new_mode;
    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_scan_mode_prepare_switch_to_host_sleep_mode(tws_chip_index_e chipIndex)
{
    TWS_U8 rd_dbg_fsm = 0x00;
    TWS_U8 idle_retry_count = 0x00;

    CVT213X_LIB_LOG_E(0, "cvt213x_scan_mode_prepare_switch to HOST_SLEEP_MODE");

    g_cvt213x_scan_mode[chipIndex].scan_mode_next = HOST_SLEEP_MODE;

    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
    cvt213x_util_delay(10);
    cvt213x_util_i2c_read(chipIndex, FSM_DBG, &rd_dbg_fsm, 1);
    while (rd_dbg_fsm != 0x01)
    {
        CVT213X_LIB_LOG_D(0, "send idle CMD retry!");

        cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
        cvt213x_util_delay(10);
        cvt213x_util_i2c_read(chipIndex, FSM_DBG, &rd_dbg_fsm, 1);
        idle_retry_count++;
        if(idle_retry_count >50)break;
    }

    if(cvt213x_get_scan_mode(chipIndex) == DOZE_MODE)
    {
        cvt213x_scan_mode_switch(chipIndex, DOZE_MODE, HOST_SLEEP_MODE);
    }
    else
    {
        cvt213x_scan_mode_switch(chipIndex, ACTIVE_MODE, HOST_SLEEP_MODE);
    }

    
#if 0

    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_COMP);//fix long press close earhone then poweron soon
    cvt213x_util_delay(1000);
    cvt213x_i2c_clear_int(chipIndex);
#else
    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_COMP); //fix long press close earhone then poweron soon
    cvt213x_util_delay(100);

    TWS_U8 rd_irq[2] = {0};
    idle_retry_count = 0;
    cvt213x_i2c_read_irq(chipIndex, rd_irq);
    CVT213X_LIB_LOG_E(1, "sleep mode get irq compdone value=0x%02x", rd_irq[0]);
    while (!(rd_irq[0] & TWS_IRQ_COMPDONE)) //check compdone
    {
        cvt213x_i2c_read_irq(chipIndex, rd_irq);
        CVT213X_LIB_LOG_E(1, "sleep mode get irq compdone value=0x%02x", rd_irq[0]);
        cvt213x_util_delay(10);
        if ((idle_retry_count++) > 50)break;
    }

    if(rd_irq[0] & TWS_IRQ_COMPDONE)
    {
        CVT213X_LIB_LOG_E(1, "sleep mode compdone OK !!!");

        idle_retry_count = 0;
        cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
        cvt213x_util_delay(10);
        cvt213x_util_i2c_read(chipIndex, FSM_DBG, &rd_dbg_fsm, 1);
        while (rd_dbg_fsm != 0x01)
        {
            CVT213X_LIB_LOG_D(0, "sleep mode send idle CMD retry!");

            cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
            cvt213x_util_delay(10);
            cvt213x_util_i2c_read(chipIndex, FSM_DBG, &rd_dbg_fsm, 1);
            idle_retry_count++;
            if(idle_retry_count >50)break;
        }
        if(rd_dbg_fsm == 0x01)
            cvt213x_util_i2c_write_dword(chipIndex,FSM_CTRL0,(HOST_SLEEP_SCAN | (REF_PHASE << 16))); //fix scan peroid
    }
    else
    {
        CVT213X_LIB_LOG_E(1, "sleep mode compdone fail !!!");
    }

    cvt213x_i2c_clear_int(chipIndex);
    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_SCAN);
#endif
    
    //debug
#if 0
    TWS_S32 rd_diff[5] = {0};
    TWS_S32 rd_avg[5] = {0};
    cvt213x_i2c_read_phase_avg_data(chipIndex, rd_avg);
    cvt213x_i2c_read_phase_diff_data(chipIndex, rd_diff);
    CVT213X_LIB_LOG_E(5, "avg: %07d, %07d, %07d, %07d, %07d", rd_avg[0], rd_avg[1], rd_avg[2], rd_avg[3], rd_avg[4]);
    CVT213X_LIB_LOG_E(5, "diff: %07d, %07d, %07d, %07d, %07d", rd_diff[0], rd_diff[1], rd_diff[2], rd_diff[3], rd_diff[4]);

    TWS_U8 data[4] = {0x00};
    cvt213x_util_i2c_read(chipIndex, FSM_IRQ, data, 4);
    CVT213X_LIB_LOG_E(1, "irq:0x%04x 0x%04x 0x%04x 0x%04x", data[0], data[1], data[2], data[3]);  
#endif        
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_scan_mode_prepare_switch_to_host_wakeup_mode(tws_chip_index_e chipIndex)
{
    TWS_U8 rd_dbg_fsm = 0x00;
    TWS_U8 idle_retry_count = 0x00;

    CVT213X_LIB_LOG_D(0, "cvt213x_scan_mode_prepare_switch_to_host_wakeup_mode");
    
#if IS_TK_ENABLE
    cvt213x_gesture_cfg_init(chipIndex);
    cvt213x_gesture_var_init(chipIndex);
#endif
    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
    cvt213x_util_delay(10);
    cvt213x_util_i2c_read(chipIndex, FSM_DBG, &rd_dbg_fsm, 1);
    while (rd_dbg_fsm != 0x01)
    {
        CVT213X_LIB_LOG_D(0, "send idle CMD retry!");

        cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
        cvt213x_util_delay(10);
        cvt213x_util_i2c_read(chipIndex, FSM_DBG, &rd_dbg_fsm, 1);
        idle_retry_count++;
        if(idle_retry_count >50)break;
    }

    cvt213x_i2c_clear_int(chipIndex);

    cvt213x_scan_mode_switch(chipIndex, NULL_MODE, HOST_WAKEUP_MODE);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
tws_ret_e cvt213x_scan_mode_switch(tws_chip_index_e chipIndex, enum_scan_mode cur_mode, enum_scan_mode new_mode)
{
    CVT213X_LIB_LOG_D(2, "[mode ctrl]cvt213x_scan_mode_switch from cur_mode(%d) to new_mode(%d)", cur_mode, new_mode);

    if (cur_mode == NULL_MODE)
    {
        if (new_mode == DEFAULT_MODE)
        {
            g_cvt213x_scan_mode[chipIndex].scan_mode_next = NULL_MODE;
            g_cvt213x_scan_mode[chipIndex].scan_mode = DEFAULT_MODE;

            cvt213x_util_set_init_flag(chipIndex, NEED_INIT);
            if (cvt213x_i2c_reset(chipIndex) == TWS_RET_OK)
            {
                cvt213x_i2c_load_reg(chipIndex, DEFAULT_MODE);
                cvt213x_util_set_init_flag(chipIndex, INIT_DONE);
                cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_START);
            }
            else
            {
                cvt213x_scan_mode_init(chipIndex);
                return TWS_RET_TIME_OUT;
            }
        }
        else if (new_mode == HOST_WAKEUP_MODE)
        {
            g_cvt213x_scan_mode[chipIndex].scan_mode_next = NULL_MODE;
            g_cvt213x_scan_mode[chipIndex].scan_mode = DOZE_MODE;

            cvt213x_i2c_load_reg(chipIndex, new_mode);
#if CVT213X_FLASH_EN
            #if 0
            TWS_U8 efuse_reg[4] = {0};
            if(cvt213x_efuse_list_set_info_to_register(efuse_reg)== TRUE)
            {
                cvt213x_util_i2c_write(chipIndex, PMU_TRIM0,efuse_reg, 4);
            }
            #endif
#endif
            cvt213x_i2c_clear_int(chipIndex);
            cvt213x_util_set_init_flag(chipIndex, INIT_DONE);
            cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_SCAN);
        }
    }
    else if (cur_mode == DEFAULT_MODE)
    {
        if (new_mode == INIT_MODE)
        {
            g_cvt213x_scan_mode[chipIndex].scan_mode_next = NULL_MODE;
            g_cvt213x_scan_mode[chipIndex].scan_mode = INIT_MODE;
        }
    }
    else if (cur_mode == INIT_MODE)
    {
        if (new_mode == DOZE_MODE)
        {
            g_cvt213x_scan_mode[chipIndex].scan_mode_next = NULL_MODE;
            g_cvt213x_scan_mode[chipIndex].scan_mode = new_mode;
            cvt213x_i2c_load_reg(chipIndex, INIT_MODE);
            cvt213x_i2c_load_reg(chipIndex, new_mode);
            cvt213x_i2c_clear_int(chipIndex);
            cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_SCAN);
        }
    }
    else if (cur_mode == DOZE_MODE)
    {
        if ((new_mode == ACTIVE_MODE) || (new_mode == HOST_SLEEP_MODE))
        {
            g_cvt213x_scan_mode[chipIndex].scan_mode_next = NULL_MODE;
            g_cvt213x_scan_mode[chipIndex].scan_mode = new_mode;

            if (new_mode == HOST_SLEEP_MODE)
            {
                cvt213x_i2c_load_reg(chipIndex, new_mode);
                cvt213x_i2c_clear_int(chipIndex);
                cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_SCAN);
            }
        }
    }
    else if (cur_mode == ACTIVE_MODE)
    {
        if ((new_mode == DOZE_MODE) || (new_mode == HOST_SLEEP_MODE))
        {
            g_cvt213x_scan_mode[chipIndex].scan_mode_next = NULL_MODE;
            g_cvt213x_scan_mode[chipIndex].scan_mode = new_mode;
            
            if (new_mode == HOST_SLEEP_MODE)
            {
                cvt213x_i2c_load_reg(chipIndex, new_mode);
                cvt213x_i2c_clear_int(chipIndex);
                cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_SCAN);
            }
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
tws_ret_e cvt213x_init(tws_chip_index_e chipIndex)
{
    CVT213X_LIB_LOG_D(1, "chip%d,cvt213x_init() enter",chipIndex);

#if IS_TK_ENABLE
    cvt213x_gesture_cfg_init(chipIndex);
    cvt213x_gesture_var_init(chipIndex);
#endif

#if IS_IED_ENABLE
    cvt213x_ied_var_init(chipIndex);
#endif

    return cvt213x_scan_mode_switch(chipIndex, NULL_MODE, DEFAULT_MODE);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void cvt213x_sleep(tws_chip_index_e chipIndex)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_sleep() enter");

    cvt213x_util_set_init_flag(chipIndex, CVT_POWER_ON);
    cvt213x_scan_mode_init(chipIndex);
    
    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_RESET);
    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_ENTER_SLEEP);
    return;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
TWS_S32 cvt213x_wakeup(tws_chip_index_e chipIndex)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_wakeup() enter");

#if IS_TK_ENABLE
    cvt213x_gesture_var_init(chipIndex);
#endif

#if IS_IED_ENABLE
    cvt213x_ied_var_init(chipIndex);
#endif

#if CVT213X_TRX_EN
    cvt213x_dongle_clear_event();
#endif

    return cvt213x_scan_mode_switch(chipIndex, NULL_MODE, DEFAULT_MODE);
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
tws_ret_e cvt213x_check_idle(tws_chip_index_e chipIndex)
{
    TWS_U8 rd_irq[2] = {0};
    TWS_U16 wait_cnt = 0;
    TWS_BOOL io_state;

    CVT213X_LIB_LOG_D(0, "cvt213x_check_idle(): enter");

    cvt213x_i2c_clear_int(chipIndex);
    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);

    while (!((rd_irq[0] & TWS_IRQ_READY) && (rd_irq[0] != 0xFF)))//wait idle done irq
    {
        //wait irq pin be low level
        io_state = cvt213x_util_wait_eint(chipIndex, 200);
        if (TRUE == io_state)
        {
            CVT213X_LIB_LOG_D(0, "cvt213x irq low");
            cvt213x_i2c_read_irq(chipIndex, rd_irq); //update irq state
            cvt213x_i2c_clear_int(chipIndex);      //clear irq
        }
        else
        {
            CVT213X_LIB_LOG_D(1, "cvt213x irq high, wait_cnt = %d", wait_cnt);
            return TWS_RET_IRQ_IO_ERROR;
        }
        
        cvt213x_util_delay(1);
        
        wait_cnt++;
        if (wait_cnt > MAX_TIME_OUT_MS_WAIT_IRQ)
        {
            CVT213X_LIB_LOG_D(1, "cvt213x i2c NG, wait_cnt = %d", wait_cnt);
            return TWS_RET_I2C_IO_ERROR;
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
TWS_BOOL cvt213x_smt_check_channel(tws_chip_index_e chipIndex)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_smt_check_channel(): enter");

    tws_ret_e io_ret = cvt213x_check_idle(chipIndex);
    if (TWS_RET_OK == io_ret)
    {
        return TRUE;
    }

    return FALSE;
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void  cvt213x_i2c_read_phase_raw_data(tws_chip_index_e chipIndex, TWS_S32 *rd_raw)
{
    TWS_U8 rd_data[4] = {0};
    TWS_U8 i = 0,len = 5;

    if (CVT213X_IC_TYPE_SELECT == IC_TYPE_CVT2138)
        len = 8;

    for (i = 0; i < len; i++)
    {
        cvt213x_util_i2c_read(chipIndex, PROC_RDAT0 + (i * 0x100), rd_data, 4);
        rd_data[3] = 0;
        rd_raw[i] = 0;
        if (rd_data[2] & 0x10)
        {
            rd_raw[i]  = (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
            rd_raw[i] -= 0x00200000;
        }
        else
        {
            rd_raw[i] |= (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
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
void  cvt213x_i2c_read_phase_avg_data(tws_chip_index_e chipIndex, TWS_S32 *rd_avg)
{
    TWS_U8 rd_data[4] = {0};
    TWS_U8 i = 0,len = 5;

    if (CVT213X_IC_TYPE_SELECT == IC_TYPE_CVT2138)
        len = 8;
        
    for (i = 0; i < len; i++)
    {
        cvt213x_util_i2c_read(chipIndex, PROC_RDAT1 + (i * 0x100), rd_data, 4);
        rd_data[3] = 0;
        rd_avg[i] = 0;
        if (rd_data[2] & 0x10)
        {
            rd_avg[i]  = (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
            rd_avg[i] -= 0x00200000;
        }
        else
        {
            rd_avg[i] |= (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
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
void  cvt213x_i2c_read_phase_diff_data(tws_chip_index_e chipIndex, TWS_S32 *rd_diff)
{
    TWS_U8 rd_data[4] = {0};
    TWS_U8 i = 0,len = 5;

    if (CVT213X_IC_TYPE_SELECT == IC_TYPE_CVT2138)
        len = 8;
        
    for (i = 0; i < len; i++)
    {
        cvt213x_util_i2c_read(chipIndex, PROC_RDAT2 + (i * 0x100), rd_data, 4);
        rd_data[3] = 0;
        rd_diff[i] = 0;
        if (rd_data[2] & 0x10)
        {
            rd_diff[i]  = (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
            rd_diff[i] -= 0x00200000;
        }
        else
        {
            rd_diff[i] |= (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
        }
        rd_diff[i] *= 2;//实际diff值是寄存器值的2倍
    }
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void  cvt213x_get_phase_diff_data(tws_chip_index_e chipIndex,TWS_U8 ph_channel,TWS_S32 *rd_diff)
{
    TWS_U8 rd_data[4] = {0};

    cvt213x_util_i2c_read(chipIndex, PROC_RDAT2 + (ph_channel * 0x100), rd_data, 4);
    rd_data[3] = 0;
    rd_diff[0] = 0;
    if (rd_data[2] & 0x10)
    {
        rd_diff[0]  = (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
        rd_diff[0] -= 0x00200000;
    }
    else
    {
        rd_diff[0] |= (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
    }
    rd_diff[0] *= 2;//实际diff值是寄存器值的2倍
}

#define GET_COMP_CCA(value)     ((value) & 0x00007FFF)
#define GET_COMP_CCB(value)     ((value >> 16) & 0x00007FFF)
/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
void  cvt213x_i2c_read_comp_data(tws_chip_index_e chipIndex, TWS_S32 *rd_raw)
{
    TWS_U8 rd_data[4] = {0};
    TWS_U8 i = 0,len = 5;

    CVT213X_LIB_LOG_D(0, "cvt213x_i2c_read_comp_data() enter");

    if (CVT213X_IC_TYPE_SELECT == IC_TYPE_CVT2138)
        len = 8;
        
    for (i = 0; i < len; i++)
    {
        cvt213x_util_i2c_read(chipIndex, PROC_COMP + (i * 0x100), rd_data, 4);
        rd_raw[i] = 0;
        rd_raw[i]  = (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
        CVT213X_LIB_LOG_E(5, "ph%d, reg value: 0x%08x, cca = %d, ccb = %d, loading = %dpF", i, rd_raw[i], GET_COMP_CCA(rd_raw[i]), GET_COMP_CCB(rd_raw[i]), (TWS_U32)((GET_COMP_CCA(rd_raw[i]) * 105) / 10000));
    }
}

/*****************************************************************
  * @brief      
  * @param[in]  
  * @param[out] 
  * @retval     
  * @note
  ****************************************************************/
char *cvt213x_get_version(void)
{
    return PLATFORM_INNER_VERSION;
}

