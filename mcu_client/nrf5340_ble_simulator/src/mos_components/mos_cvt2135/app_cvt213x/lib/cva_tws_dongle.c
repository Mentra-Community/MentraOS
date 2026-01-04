/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_dongle.c
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
#include "cva_tws_dongle.h"
#include "cva_tws_flash.h"
#include "cva_tws_util.h"
#include "cva_tws_gesture.h"
#include "cva_tws_i2c.h"
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(cva_tws_dongle, LOG_LEVEL_INF);
#if CVT213X_TRX_EN
/*******************************************************************************
* 2.Private constant and macro definitions using #define
*******************************************************************************/
#define TX_BUFF_SIZE_MAX 64
#define RX_BUFF_SIZE_MAX 64
/*******************************************************************************
* 3.Private enumerations, structures and unions using typedef
*******************************************************************************/

/*******************************************************************************
* 4.Static variables
*******************************************************************************/
static TWS_U8  g_rx_buffer[RX_BUFF_SIZE_MAX] = {0};     //recieve buffer
static TWS_U8  g_tx_buffer[TX_BUFF_SIZE_MAX] = {0};     //send buffer

static TWS_U8  g_tx_buffer_index = 0;     //send buffer index

static TWS_U8  g_data_cnt = 0;            //read data count
static TWS_U8  g_data_size = 3;           //read data size in byte
static TWS_U16 g_data_info[9] = {0};      //g_data_info[0]: channel count that need to be read
                                          //g_data_info[1~8]: ch0~ch7 register address that need to be read

static tws_reg_t g_reg_info = {0, 0};     //register address and value that need to be write

static TWS_U8    g_busy_cnt = 0;          //busy counter, add 1 if new packet recieved
static trx_hanlde_state_e g_trx_handle_busy_state = TRX_ALL_FINISH; //communcation handling busy flag

static trx_test_mode_e g_test_mode_status = TRX_TEST_MODE_DIS; //mp-mode/show-mode flag
static TWS_BOOL        g_enter_mp_mode_success = FALSE;        //enter mp-mode success flag
static tws_event_e  g_event_status = TWS_EVENT_NONE; //ied/tk event

static const TWS_U16 rd_debug_reg[] ={CVT213X_AFEC_CTRL1_PH0,CVT213X_PROC_DIFF_PH0,CVT213X_PROC_COR_PH3,CVT213X_FSM_CTRL0,CVT213X_FSM_CTRL1};
static TWS_U32 rd_debug_buff[1] = {0};
static setup_cmd_e g_setup_cmd_mode = SETUP_CMD_END;
/*******************************************************************************
* 5.Global variable or extern global variabls/functions
*******************************************************************************/
extern void app_cvt213x_trx_uart_rx_packet_init(void);
extern void cvt213x_cmd_read_bluetooth_addr(TWS_U8 *earphone_addr);
extern void app_cvt213x_calibration_speed_up(void);

#if CVT213X_SETUP_FUN
extern st_setup_info_var g_setup_info_var;
extern TWS_U8 g_setup_valid;
#endif
/*******************************************************************************
* 6.Static function prototypes
******************************************************************************/
void cvt213x_message_send(tws_msg_type_e msg_type, TWS_U8 *rxbuffer);


/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_U8 cvt213x_get_test_mode_status(void)
{
    return g_test_mode_status;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_U8 cvt213x_get_cmd_mode_status(void)
{
    return g_setup_cmd_mode;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_dongle_init(void)
{
    g_tx_buffer_index = 0;
    g_data_cnt = 0;
    g_data_size = 3;
    g_busy_cnt = 0;
    g_trx_handle_busy_state &= TRX_Handle_FINISH;
    g_test_mode_status = TRX_TEST_MODE_DIS;
    g_enter_mp_mode_success = FALSE;
    g_setup_cmd_mode = SETUP_CMD_END;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_dongle_clear_event(void)
{
    g_event_status = TWS_EVENT_NONE;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_set_enter_mp_mode_flag(TWS_BOOL mode)
{
    g_enter_mp_mode_success = mode;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_get_enter_mp_mode_flag(void)
{
    return g_enter_mp_mode_success;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_message_pack(TWS_U8 len, TWS_U8 *txbuffer)
{
    TWS_U8  cksum = 0, i = 0;

    // add header and length
    g_tx_buffer[0] = 0xa5;
    g_tx_buffer[1] = 0xa5;
    g_tx_buffer[3] = len + 1; // cksum in 1 byte

    //add checksum
    for (i = 2; i < len ; ++i)
    {
        cksum ^= txbuffer[i];
    }
    g_tx_buffer[len] = cksum;
    CVT213X_TRX_LOG_D(1, "[tx]:cksum = 0x%02x", cksum);

    //clear trx busy flag after ack packet send
    g_trx_handle_busy_state &= TRX_Handle_FINISH;

    //send ack packet
    cvt213x_util_trx_tx(g_tx_buffer, g_tx_buffer[3]);
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_message_send(tws_msg_type_e msg_type, TWS_U8 *rxbuffer)
{
    TWS_U8 tx_len = 4;

    g_tx_buffer[2] = msg_type ;

    switch (msg_type)
    {
    case TWS_MSG_R_CMDSTATE:
        g_tx_buffer[4] = rxbuffer[4];
        g_tx_buffer[5] = g_trx_handle_busy_state;
        tx_len += 2;
        break;

    case TWS_MSG_R_GET_EVENT:
        g_tx_buffer[4] = g_event_status;
        tx_len += 1;
        break;

    case TWS_MSG_R_I2C_READ:
        g_tx_buffer[4] = rxbuffer[4];
        g_tx_buffer[5] = rxbuffer[5];
        tx_len       += 2 + rxbuffer[6];
        break;

    case TWS_MSG_R_I2C_WRITE:
        g_tx_buffer[4] = (TWS_U8)g_reg_info.reg;
        g_tx_buffer[5] = (TWS_U8)(g_reg_info.reg >> 8);
        tx_len       += 6;
        break;

    case TWS_MSG_R_GET_LOG:
        //get period log
        break;

    case TWS_MSG_R_GET_VERSION:
        g_tx_buffer[4] = PLATFORM_INNER_VERSION[1];
        g_tx_buffer[5] = PLATFORM_INNER_VERSION[3];
        g_tx_buffer[6] = PLATFORM_INNER_VERSION[5];
        g_tx_buffer[7] = PLATFORM_INNER_VERSION[7];
        tx_len += 4;
        break;

    case TWS_MSG_R_SET_SETUP_INFO:
#if CVT213X_SETUP_FUN
        if(rxbuffer[4] ==0x0A)
        {        
            g_tx_buffer[4] = rxbuffer[4];
            tx_len +=1;
        }
        else
        {
            for(TWS_U8 i=0;i<40;i++)
            {
                g_tx_buffer[4+i] = ((TWS_U8 *)&g_setup_info_var)[i];
            }
            tx_len +=40;
        }
#endif
        break;

    case TWS_MSG_R_GET_FLASH_CFG:
        tx_len += 11;
        break;

    case TWS_MSG_R_GET_FLASH_DATA:
        tx_len += 11;
        break;

    case TWS_MSG_R_CLEAR_FLASH_THR:
        tx_len += 11;
        break;

    case TWS_MSG_R_GET_KEY_VAR_DATA:
        tx_len += 4;
        break;

    case TWS_MSG_GET_R_BLUETOOTH_ADDR:
        g_tx_buffer[4] = rxbuffer[4];
        g_tx_buffer[5] = rxbuffer[5];
        g_tx_buffer[6] = rxbuffer[6];
        g_tx_buffer[7] = rxbuffer[7];
        g_tx_buffer[8] = rxbuffer[8];
        g_tx_buffer[9] = rxbuffer[9];
        tx_len += 6;
        break;

    case TWS_MSG_R_GET_PARAMETER_CONFIG:
        for(TWS_U8 i=0;i<54;i++)
        {
            g_tx_buffer[4+i] = rxbuffer[4+i];
        }
        tx_len += 54;
        break;
        
    case TWS_MSG_R_SET_PARAMETER_CONFIG:
        g_tx_buffer[4] = rxbuffer[4];
        tx_len += 1;
        break;
    default:
        break;
    }

    if (TWS_MSG_R_GET_DIFF <= msg_type && TWS_MSG_R_GET_PROC_DIFF >= msg_type)
    {
        g_tx_buffer[4] = rxbuffer[4];
        g_tx_buffer[5] = rxbuffer[5];
        tx_len += g_tx_buffer[3];
    }

    cvt213x_message_pack(tx_len, &g_tx_buffer[0]);
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_task_trx_delay_read(void)
{
    TWS_U8 rd_data[4] = {0};
    TWS_U8 i, j;

    for (i = 1; i < g_data_info[0]; ++i)
    {
        if((CVT213X_IC_TYPE_SELECT != IC_TYPE_CVT2138) && (i >= 6)) 
        {
            rd_data[0] =0x00;
            rd_data[1] =0x00;
            rd_data[2] =0x00;
            rd_data[3] =0x00;
        }
        else
        {
            cvt213x_util_i2c_read(CVT213X_TRX_SLE, g_data_info[i], rd_data, g_data_size);
        }

        for (j = 0; j < g_data_size; ++j)
        {
        #if CVT213X_SETUP_FUN
            if ((cvt213x_ied_get_last_prox_state()) && (TRX_TEST_MODE_EN != g_test_mode_status))
            {
                CVT213X_LIB_LOG_D(0, "cvt213x_task_trx_delay_read setup mode");
                if (((g_data_info[i] & 0x00FF) == 0x0030) && (i >= 4) && (i < 6)) // set PH3 PH4 raw
                {
                    TWS_S32 raw = cvt213x_setup_algo_get_raw(CVT213X_TRX_SLE, i - 4);
                    if (raw < 0)
                    {
                        raw += 0x200000;
                    }
                    g_tx_buffer[g_tx_buffer_index++] = (raw >> (j*8)) & 0xff;
                }
                else if (((g_data_info[i] & 0x00FF) == 0x0038) && (i >= 4) && (i < 6)) //set PH3 PH4 diff
                {
                    TWS_S32 diff = cvt213x_setup_algo_get_diff(CVT213X_TRX_SLE, i - 4);
                    if (diff >= 0)
                    {
                        diff /= 2;
                    }
                    else
                    {
                        diff /= 2;
                        diff += 0x200000;
                    }
                    g_tx_buffer[g_tx_buffer_index++] = (diff >> (j*8)) & 0xff;
                }
                else
                {
                    g_tx_buffer[g_tx_buffer_index++] = rd_data[j];
                }
            }
            else
        #endif
            {
                CVT213X_LIB_LOG_D(1, "cvt213x_task_trx_delay_read hardware");
                g_tx_buffer[g_tx_buffer_index++] = rd_data[j];
            }
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
static void cvt213x_task_trx_delay_write(void)
{
    TWS_U8 wr_data[4] = {0};

    wr_data[0] = (TWS_U8)(g_reg_info.val & 0x000000FFU);
    wr_data[1] = (TWS_U8)(g_reg_info.val & 0x0000FF00U) >> 8;
    wr_data[2] = (TWS_U8)(g_reg_info.val & 0x00FF0000U) >> 16;
    wr_data[3] = (TWS_U8)(g_reg_info.val & 0xFF000000U) >> 24;

    cvt213x_util_i2c_write(CVT213X_TRX_SLE, g_reg_info.reg, wr_data, 4);

    cvt213x_i2c_send_cmd(CVT213X_TRX_SLE, TWS_CMD_SCAN);
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_cmd_exit_mp_mode_proc(void)
{
    g_data_cnt = 0;
    cvt213x_set_enter_mp_mode_flag(FALSE);

    cvt213x_scan_mode_switch(CVT213X_TRX_SLE, NULL_MODE, DEFAULT_MODE);
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_cmd_enter_mp_mode_proc(void)
{
#if CVT213X_SETUP_FUN
    g_setup_cmd_mode =SETUP_CMD_MP_WRITE;
    cvt213x_is_earphone_in_box_state_set(1);//force set ephone state in box ,then init cvt2135
    cvt213x_wakeup(TWS_CHIP_0);
    app_cvt213x_calibration_speed_up();      //accelerate cvt2135 init
    cvt213x_manual_reset_host(TWS_CHIP_0);
#endif

    g_data_cnt = 0;

    tws_ret_e io_ret = cvt213x_check_idle(CVT213X_TRX_SLE);

    if (TWS_RET_OK == io_ret)
    {
        CVT213X_TRX_LOG_D(0, "io_ret ok");

        cvt213x_i2c_mp_init(CVT213X_TRX_SLE);

        cvt213x_set_enter_mp_mode_flag(TRUE);
        g_data_cnt = 0;
    }
    else
    {
        cvt213x_set_enter_mp_mode_flag(FALSE);
        g_rx_buffer[4] = TRX_TEST_MODE_DIS;
    }
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_cmd_write_reg(TWS_U16 addr, TWS_U8 *buff, TWS_U8 len)
{
    CVT213X_UNUSED(len);

    cvt213x_i2c_clear_int(CVT213X_TRX_SLE);

    cvt213x_i2c_send_cmd(CVT213X_TRX_SLE, TWS_CMD_IDLE);

    g_data_cnt = WAIT_IRQ_MODE_WRITE;

    g_reg_info.reg = addr;
    g_reg_info.val = (TWS_U32)buff[0] | (((TWS_U32)buff[1]) << 8) | (((TWS_U32)buff[2]) << 16) | (((TWS_U32)buff[3]) << 24);
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_set_read_info(TWS_U16 ADR_BASE, TWS_U16 ADR_OFFSET)
{
    TWS_U8 i = 0;
    TWS_U16 ADR_OFFSET_TEMP = 0;

    TWS_U8 read_channel_cnt = 1;//1 means no channel need to be read; 2 means 1 channel need to be read...

    TWS_U8 chan_validation  = g_rx_buffer[4];
    TWS_U8 frame    = g_rx_buffer[6];

    g_data_size  = g_rx_buffer[5] & 0x0f;
    g_data_cnt = g_rx_buffer[6];

    for (i = 0; i < 8; ++i)
    {
        TWS_U8 chan_mask = 0x01 << i;
        if (chan_validation & chan_mask)
        {
            g_data_info[read_channel_cnt++] = ADR_BASE + ADR_OFFSET_TEMP;
        }

        ADR_OFFSET_TEMP += ADR_OFFSET;
    }

    g_data_info[0] = read_channel_cnt;
    g_tx_buffer[3] = (read_channel_cnt - 1) * g_data_size * frame + 2;
    g_tx_buffer_index = 6;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void  cvt213x_cmd_read_mass_data(TWS_U16 ADR_BASE, TWS_U16 ADR_OFFSET)
{
    cvt213x_set_read_info(ADR_BASE, ADR_OFFSET);

    if (g_test_mode_status != TRX_TEST_MODE_EN)
    {
        while (g_data_cnt)
        {
            g_data_cnt--;
            cvt213x_task_trx_delay_read();
            if (0 == g_data_cnt)
            {
                if (TWS_MSG_GET_DIFF <= g_rx_buffer[2])
                {
                    cvt213x_message_send((tws_msg_type_e)(g_rx_buffer[2] + 1), g_rx_buffer);
                }
            }
            else
            {
                cvt213x_util_delay(100);
            }
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
static void cvt213x_cmd_read_key_var(TWS_U8 key_var_index)
{
    TWS_U32 value = 0;

    if (key_var_index == 0)
    {
        value = (TWS_U32)cvt213x_get_scan_mode(CVT213X_TRX_SLE);
    }
    else if (key_var_index == 1)
    {
        value = (TWS_U32)cvt213x_get_next_scan_mode(CVT213X_TRX_SLE);
    }
    else if (key_var_index == 2)
    {
        value = (TWS_U32)g_test_mode_status;
    }
    else if (key_var_index == 3)
    {
        value = (TWS_U32)cvt213x_util_get_init_flag(CVT213X_TRX_SLE);
    }

    g_tx_buffer[4] = (TWS_U8)(value & 0x000000FF);
    g_tx_buffer[5] = (TWS_U8)((value >> 8) & 0x000000FF);
    g_tx_buffer[6] = (TWS_U8)((value >> 16) & 0x000000FF);
    g_tx_buffer[7] = (TWS_U8)((value >> 24) & 0x000000FF);

    cvt213x_message_send((tws_msg_type_e)(g_rx_buffer[2] + 1), g_rx_buffer);
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_trx_cmd_handler(TWS_U8 *buffer)
{
    g_data_cnt = 0;

    CVT213X_TRX_LOG_D(1, "cmd = 0x%02x", buffer[2]);
    switch (buffer[2])
    {
    case TWS_MSG_TEST_MODE_STATUS:
    {
        CVT213X_TRX_LOG_D(2, "test mode status:%d -> %d", g_test_mode_status, buffer[4]);
        g_test_mode_status = (trx_test_mode_e)buffer[4];
        cvt213x_set_enter_mp_mode_flag(FALSE);
        if (TRX_TEST_MODE_DIS == g_test_mode_status)
        {
            cvt213x_cmd_exit_mp_mode_proc();
        }
        else if (TRX_TEST_MODE_EN == g_test_mode_status)
        {
            cvt213x_cmd_enter_mp_mode_proc();
        }
        cvt213x_message_send(TWS_MSG_R_CMDSTATE, &buffer[0]);
        break;
    }

    case TWS_MSG_I2C_READ:
    {
        TWS_U8   rd_diff[4];
        TWS_U8   index = 0;
        TWS_U16  u16_buff = buffer[5];
        u16_buff = (u16_buff << 8) + buffer[4];

        cvt213x_util_i2c_read(CVT213X_TRX_SLE, u16_buff, rd_diff, 4);
        CVT213X_TRX_LOG_D(4, "i2c read= %x %x %x %x", rd_diff[0], rd_diff[1], rd_diff[2], rd_diff[3]);
        for (index = 0; index < 4; index++)
        {
            g_tx_buffer[6 + index] = rd_diff[index];
        }
        cvt213x_message_send(TWS_MSG_R_I2C_READ, &buffer[0]);
        break;
    }

    case TWS_MSG_I2C_WRITE:
    {
        TWS_U16  u16_buff = buffer[5];
        u16_buff = (u16_buff << 8) + buffer[4];

        if(cvt213x_get_test_mode_status() != TRX_TEST_MODE_EN)//app mode ,swtich idle before write reg
        {
            TWS_U8 rd_dbg_fsm = 0x00,loop_cnt =0;
            cvt213x_i2c_send_cmd(CVT213X_TRX_SLE, TWS_CMD_IDLE);
            cvt213x_util_delay(10);
            cvt213x_util_i2c_read(CVT213X_TRX_SLE, FSM_DBG, &rd_dbg_fsm, 1);
            while (rd_dbg_fsm != 0x01)
            {
                CVT213X_LIB_LOG_D(1, "send idle err! retry!");
                cvt213x_i2c_send_cmd(CVT213X_TRX_SLE, TWS_CMD_IDLE);
                cvt213x_util_delay(10);
                cvt213x_util_i2c_read(CVT213X_TRX_SLE, FSM_DBG, &rd_dbg_fsm, 1);
                loop_cnt++;
                if (loop_cnt >= 50)
                {
                    break;
                }
            }
            cvt213x_util_i2c_write(CVT213X_TRX_SLE,u16_buff,&buffer[7], buffer[6]);
            cvt213x_i2c_clear_int(CVT213X_TRX_SLE);
            cvt213x_i2c_send_cmd(CVT213X_TRX_SLE, TWS_CMD_SCAN); //recover normal flow
        }
        else
        {
            cvt213x_cmd_write_reg(u16_buff, &buffer[7], buffer[6]);
        }
        break;
    }

    case TWS_MSG_GET_LOG:
    {
        break;
    }

    case TWS_MSG_GET_VERSION:
    {
        cvt213x_message_send(TWS_MSG_R_GET_VERSION, &buffer[0]);
        break;
    }

    case TWS_MSG_HOST_CMD:
    {
        if (buffer[4] < TWS_CMD_MAX)
        {
            cvt213x_i2c_send_cmd(CVT213X_TRX_SLE, (enum_tws_cmd_e)buffer[4]);
        }
        else
        {
            if (buffer[4] == 0x10)
            {
                cvt213x_sleep(CVT213X_TRX_SLE);
            }
            else if (buffer[4] == 0x11)
            {
            #if CVT213X_SETUP_FUN
                cvt213x_is_earphone_in_box_state_set(1);//force set ephone state in box ,then init cvt2135
            #endif
                cvt213x_wakeup(CVT213X_TRX_SLE);
            }
        }
        g_trx_handle_busy_state &= TRX_Handle_FINISH;
        
        break;
    }

    case TWS_MSG_SET_MODE:
    {
        tws_ret_e io_ret = cvt213x_check_idle(CVT213X_TRX_SLE);
        if (TWS_RET_OK == io_ret)
        {
            cvt213x_i2c_load_reg(CVT213X_TRX_SLE, (enum_scan_mode)buffer[4]);

        }
        break;
    }

    case TWS_MSG_GET_AFEC:
    {
        CVT213X_TRX_LOG_D(0, "TWS_MSG_GET_AFEC");
        cvt213x_cmd_read_mass_data(AFEC_ADR_BASE, AFEC_ADR_OFFSET);
        break;
    }

    case TWS_MSG_GET_DIFF:
    {
        CVT213X_TRX_LOG_D(0, "TWS_MSG_GET_DIFF");
        cvt213x_cmd_read_mass_data(DIFF_ADR_BASE, BASE_ADR_OFFSET);
        break;
    }

    case TWS_MSG_GET_RAW:
    {
        cvt213x_cmd_read_mass_data(RAW_ADR_BASE, BASE_ADR_OFFSET);
        break;
    }

    case TWS_MSG_GET_CC:
    {
        cvt213x_cmd_read_mass_data(CC_ADR_BASE, BASE_ADR_OFFSET);
        break;
    }

    case TWS_MSG_GET_PROC_DIFF:
    {
        cvt213x_cmd_read_mass_data(PROC_ADR_BASE, BASE_ADR_OFFSET);
        break;
    }

    case TWS_MSG_GET_EVENT:
    {
        buffer[4] = g_event_status;
        cvt213x_message_send((tws_msg_type_e)(buffer[2] + 1), &buffer[0]);
        break;
    }

    case TWS_MSG_GET_DEBUG_DATA:
    {
        break;
    }

    case TWS_MSG_GET_FLASH_CFG:
    {
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

        cvt213x_cali_list_get_info_from_trx(buffer);

        cvt213x_cali_list_write_to_flash_and_all_reset();

        cvt213x_cali_list_get_info_from_register(reg_cali);

        cvt213x_cali_list_set_info_to_trx(g_tx_buffer);

        cvt213x_message_send((tws_msg_type_e)(buffer[2] + 1), &buffer[0]);
#endif
        break;
    }

    case TWS_MSG_SET_SETUP_INFO:
    {
#if CVT213X_SETUP_FUN
        g_setup_cmd_mode = buffer[4];
        if(g_setup_cmd_mode == SETUP_CMD_MP_WRITE) //MP write setup info
        {
            g_setup_valid =1;
            cvt213x_set_setup_info_to_flash();
        }
        else if(g_setup_cmd_mode == SETUP_CMD_APP_WRITE) //app write setup info
        {
            cvt213x_is_earphone_in_box_state_set(1);//force set ephone state in box ,then init cvt2135
            cvt213x_wakeup(TWS_CHIP_0);
            app_cvt213x_calibration_speed_up();      //accelerate cvt2135 init
            cvt213x_manual_reset_host(TWS_CHIP_0);
            cvt213x_set_setup_info_to_flash();
        }
        else if(g_setup_cmd_mode == SETUP_CMD_READ) //read setup info
        {
        }
        else if(g_setup_cmd_mode == SETUP_CMD_CLEAR) //clear setup info
        {
            cvt213x_setup_info_clear();       
        }

        // if((g_setup_cmd_mode >=SETUP_CMD_MP_WRITE)&&(g_setup_cmd_mode <=SETUP_CMD_CLEAR))
        if(g_setup_cmd_mode <=SETUP_CMD_END)
        {
            cvt213x_get_setup_info_from_flash();
            if ((!cvt213x_setup_info_check_validation((TWS_U8 *)&g_setup_info_var, sizeof(g_setup_info_var)))&&(buffer[4] <=2))
                buffer[4] = 0x0A;
            else
                buffer[4] = ((TWS_U8 *)&g_setup_info_var)[0];
        }
        else
            buffer[4] = 0x0A;

        cvt213x_message_send((tws_msg_type_e)(buffer[2] + 1), &buffer[0]);
        g_setup_cmd_mode = SETUP_CMD_END;
#endif
        break;
    }

    case TWS_MSG_GET_FLASH_DATA:
    {
#if CVT213X_FLASH_EN
        // if((buffer[4]) == 5)
        {
            cvt213x_cali_list_get_info_from_flash();
            cvt213x_cali_list_get_flash_data_check();
            cvt213x_cali_list_set_info_to_trx(g_tx_buffer);
            cvt213x_message_send((tws_msg_type_e)(buffer[2] + 1), &buffer[0]);
        }
#endif
        break;
    }

    case TWS_MSG_CLEAR_FLASH_THR:
    {
#if CVT213X_FLASH_EN
        TWS_U8 cali_thr_buff[16] = {0};
        cvt213x_util_flash_write(cali_thr_buff, 16);

        cvt213x_cali_list_get_info_from_flash();
        cvt213x_cali_list_get_flash_data_check();
        cvt213x_cali_list_set_info_to_trx(g_tx_buffer);
        cvt213x_message_send((tws_msg_type_e)(buffer[2] + 1), &buffer[0]);
#endif
        break;
    }
        

    case TWS_MSG_GET_KEY_VAR_DATA:
    {
        cvt213x_cmd_read_key_var(buffer[4]);
        break;
    }

    case TWS_MSG_GET_BLUETOOTH_ADDR:
    {
        TWS_U8 bluetoothaddr[6] = {0};
        cvt213x_cmd_read_bluetooth_addr(bluetoothaddr);
        buffer[4] = bluetoothaddr[0];
        buffer[5] = bluetoothaddr[1];
        buffer[6] = bluetoothaddr[2];
        buffer[7] = bluetoothaddr[3];
        buffer[8] = bluetoothaddr[4];
        buffer[9] = bluetoothaddr[5];
        cvt213x_message_send((tws_msg_type_e)(buffer[2] + 1), &buffer[0]);
        break;
    }

    case TWS_MSG_GET_PARAMETER_CONFIG:
    {
        TWS_U8 start_index = 4;
        for(TWS_U8 i=0;i<5;i++)
        {
            rd_debug_buff[0] = 0x0000;
            switch (rd_debug_reg[i])
            {
            case CVT213X_AFEC_CTRL1_PH0:
                for(TWS_U8 x=0;x<8;x++)
                {
                    cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,(CVT213X_AFEC_CTRL1_PH0+0x10*x),rd_debug_buff);
                    buffer[start_index] =(TWS_U8)((rd_debug_buff[0]>>0)&0x0F); //PH0_FREQUENCY start_index =4;7;10;13;16;19
                    buffer[start_index+1] =(TWS_U8)((rd_debug_buff[0]>>8)&0x0F);//PH0_RESOLUTION
                    buffer[start_index+2] =(TWS_U8)((rd_debug_buff[0]>>28)&0x0F);//PH0_CF_SEL
                    start_index += 3;
                }
            break;
            case CVT213X_PROC_DIFF_PH0:
                for(TWS_U8 m=0;m<8;m++)
                {
                    cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,(CVT213X_PROC_DIFF_PH0+0x100*m),rd_debug_buff);
                    buffer[start_index] =(TWS_U8)((rd_debug_buff[0]>>0)&0xFF); //PH0_THRE
                    buffer[start_index+1] =(TWS_U8)((rd_debug_buff[0]>>8)&0x0F);//PH0_FACT
                    start_index += 2;
                }
            break;
            case CVT213X_PROC_COR_PH3:
                for(TWS_U8 n=0;n<2;n++)
                {
                    cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,(CVT213X_PROC_COR_PH3+0x100*n),rd_debug_buff);
                    CVT213X_TRX_LOG_D(0, "1");
                    buffer[start_index] =(TWS_U8)((rd_debug_buff[0]>>16)&0x0F); //COR_EN
                    buffer[start_index+1] =(TWS_U8)((rd_debug_buff[0]>>24)&0xFF);//COEF

                    cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,(CVT213X_PROC_AVGFLT_PH3+0x100*n),rd_debug_buff);
                    CVT213X_TRX_LOG_D(0, "2");
                    buffer[start_index+2] =(TWS_U8)((rd_debug_buff[0]>>0)&0x07); //AVGP 0:2
                    buffer[start_index+3] =(TWS_U8)((rd_debug_buff[0]>>4)&0x07);//AVGN 4:6

                    start_index += 4;
                }
            break;
            case CVT213X_FSM_CTRL0:
                cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,CVT213X_FSM_CTRL0,rd_debug_buff);
                CVT213X_TRX_LOG_D(0, "3");
                buffer[start_index] =(TWS_U8)((rd_debug_buff[0]>>8)&0xFF); //SCAN_P 0:10
                buffer[start_index+1] =(TWS_U8)((rd_debug_buff[0]>>0)&0xFF); //SCAN_P 12:15
                buffer[start_index+2] =(TWS_U8)((rd_debug_buff[0]>>16)&0xFF); //REF_PHASE 16:24
                start_index += 3;
            break;
            case CVT213X_FSM_CTRL1:
                cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,CVT213X_FSM_CTRL1,rd_debug_buff);
                CVT213X_TRX_LOG_D(0, "4");
                buffer[start_index] =(TWS_U8)((rd_debug_buff[0]>>26)&0x0F);//REF_EN
                buffer[start_index+1] =(TWS_U8)((rd_debug_buff[0]>>0)&0xFF); //COMPEN
                //log level
                buffer[start_index+2] = ((g_cvt213x_app_level) | (g_cvt213x_lib_level << 2) | (g_cvt213x_trx_level << 4));
                start_index += 3;
            break;
            default:
                break;
            }
        }
        cvt213x_message_send((tws_msg_type_e)(buffer[2] + 1), &buffer[0]);
        break;
    }
    case TWS_MSG_SET_PARAMETER_CONFIG:
    {
        TWS_U8 rd_dbg_fsm = 0x00,idle_retry_count=0;

        cvt213x_i2c_send_cmd(CVT213X_TRX_SLE, TWS_CMD_IDLE);
        cvt213x_util_delay(10);
        cvt213x_util_i2c_read(CVT213X_TRX_SLE, FSM_DBG, &rd_dbg_fsm, 1);
        while (rd_dbg_fsm != 0x01)
        {
            CVT213X_LIB_LOG_D(0, "send idle CMD retry!");
            cvt213x_i2c_send_cmd(CVT213X_TRX_SLE, TWS_CMD_IDLE);
            cvt213x_util_delay(10);
            cvt213x_util_i2c_read(CVT213X_TRX_SLE, FSM_DBG, &rd_dbg_fsm, 1);
            idle_retry_count++;
            if(idle_retry_count >10)break;
        }
        cvt213x_i2c_clear_int(CVT213X_TRX_SLE);

        TWS_U8 start_index = 4;
        for(TWS_U8 i=0;i<5;i++)
        {
            rd_debug_buff[0] = 0x0000;
            switch (rd_debug_reg[i])
            {
            case CVT213X_AFEC_CTRL1_PH0:
                for(TWS_U8 x=0;x<8;x++)
                {
                    cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,(CVT213X_AFEC_CTRL1_PH0+0x10*x),rd_debug_buff);
                    rd_debug_buff[0] = (((rd_debug_buff[0] &~(0x0F<<0)) &~(0x0F<<8)) &~(0x0F<<28)) | ((buffer[start_index]<<0) | (buffer[start_index+1]<<8)| (buffer[start_index+2]<<28));
                    cvt213x_util_i2c_write_dword(CVT213X_TRX_SLE,(CVT213X_AFEC_CTRL1_PH0+0x10*x),rd_debug_buff[0]);
                    start_index += 3;
                }
            break;
            case CVT213X_PROC_DIFF_PH0:
                for(TWS_U8 m=0;m<8;m++)
                {
                    cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,(CVT213X_PROC_DIFF_PH0+0x100*m),rd_debug_buff);
                    rd_debug_buff[0] = ((rd_debug_buff[0] &~(0xFF<<0)) &~(0x0F<<8)) | ((buffer[start_index]<<0) | (buffer[start_index+1]<<8));
                    cvt213x_util_i2c_write_dword(CVT213X_TRX_SLE,(CVT213X_PROC_DIFF_PH0+0x100*m),rd_debug_buff[0]);
                    start_index += 2;
                }
            break;
            case CVT213X_PROC_COR_PH3://AVGP 0:2  //AVGN 4:6
                for(TWS_U8 n=0;n<2;n++)
                {
                    cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,(CVT213X_PROC_COR_PH3+0x100*n),rd_debug_buff);
                    rd_debug_buff[0] = ((rd_debug_buff[0] &~(0x0F<<16)) &~(0xFF<<24)) | (buffer[start_index]<<16) | ((buffer[start_index+1]<<24));
                    cvt213x_util_i2c_write_dword(CVT213X_TRX_SLE,(CVT213X_PROC_COR_PH3+0x100*n),rd_debug_buff[0]);
                    start_index += 2;

                    //cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,(CVT213X_PROC_AVGFLT_PH3+0x100*n),rd_debug_buff);
                    rd_debug_buff[0] = 0x0;
                    rd_debug_buff[0] = ((rd_debug_buff[0] | (buffer[start_index]&0x07) | ((buffer[start_index+1]<<4)&0x70)));
                    cvt213x_util_i2c_write_dword(CVT213X_TRX_SLE,(CVT213X_PROC_AVGFLT_PH3+0x100*n),rd_debug_buff[0]);
                    start_index += 2;
                }
            break;
            case CVT213X_FSM_CTRL0://SCAN_P 0:10  //REF_PHASE 16:24
                //cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,CVT213X_FSM_CTRL0,rd_debug_buff);
                rd_debug_buff[0] = 0x0;
                rd_debug_buff[0] = ((rd_debug_buff[0] | ((buffer[start_index]<<8)) | ((buffer[start_index+1]<<0)) | ((buffer[start_index+2]<<16))));
                cvt213x_util_i2c_write_dword(CVT213X_TRX_SLE,CVT213X_FSM_CTRL0,rd_debug_buff[0]);
                start_index += 3;
            break;
            case CVT213X_FSM_CTRL1:
                cvt213x_util_i2c_read_dword(CVT213X_TRX_SLE,CVT213X_FSM_CTRL1,rd_debug_buff);
                rd_debug_buff[0] = ((rd_debug_buff[0] &~(0xFF<<0)) &~(0x0F<<26)) | (buffer[start_index]<<26) | ((buffer[start_index+1]<<0));
                cvt213x_util_i2c_write_dword(CVT213X_TRX_SLE,CVT213X_FSM_CTRL1,rd_debug_buff[0]);
                //log level
                g_cvt213x_app_level = (buffer[start_index+2] & 0x03);
                g_cvt213x_lib_level = ((buffer[start_index+2] >> 2) & 0x03);
                g_cvt213x_trx_level = ((buffer[start_index+2] >> 4) & 0x03);

                start_index += 3;
            break;
            default:
                break;
            }
        }
        cvt213x_i2c_send_cmd(CVT213X_TRX_SLE, TWS_CMD_COMP);
        cvt213x_util_delay(100);
        TWS_U8 rd_irq[2] = {0};
        TWS_U8 index = 0;
        cvt213x_i2c_read_irq(CVT213X_TRX_SLE, rd_irq);
        CVT213X_LIB_LOG_D(1, "dongle init irq[0]==== 0x%x", rd_irq[0]);
        while (!(rd_irq[0] & TWS_IRQ_COMPDONE)) //check compdone
        {
            cvt213x_i2c_read_irq(CVT213X_TRX_SLE, rd_irq);
            CVT213X_LIB_LOG_D(1, "dongle init irq[0]==== 0x%x", rd_irq[0]);
			cvt213x_util_delay(10);
            if ((index++) > 50)break;
        }
        if(rd_irq[0] & TWS_IRQ_COMPDONE){buffer[4] =0x01;}else{buffer[4] =0x00;};
        cvt213x_i2c_clear_int(CVT213X_TRX_SLE);
    }
        cvt213x_message_send((tws_msg_type_e)(buffer[2] + 1), &buffer[0]);
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
void cvt213x_task_trx_connected_proc(void)
{
    TWS_U8 datTemp[5] = {'S', 'P', 'P', 'O', 'K'};

    CVT213X_TRX_LOG_D(0, "cvt213x_task_trx_connected_proc() enter");

    cvt213x_util_delay(5);
    cvt213x_util_trx_tx(datTemp, 5);

    //clear trx busy flag when connecting
    cvt213x_dongle_init();
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_task_trx_disconnected_proc(void)
{
    if (TRUE == cvt213x_get_enter_mp_mode_flag())
    {
        cvt213x_cmd_exit_mp_mode_proc();
    }
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static trx_check_status_e cvt213x_trx_cmd_check(TWS_U8 length, TWS_U8 *buffer)
{
    TWS_U8 cksum = buffer[2];
    TWS_U8 i = 0;

    // CVT213X_TRX_LOG_D(4, "[rx]:header = 0x%02x 0x%02x 0x%02x 0x%02x", buffer[0], buffer[1], buffer[2], buffer[3]);
    for (i= 0; i < length; i++)
    {
        CVT213X_TRX_LOG_D(2, "[rx][%02d]:0x%02x", i, buffer[i]);
    }

    //check header
    if (buffer[0] != 0xa5 || buffer[1] != 0xa5)
    {
        CVT213X_TRX_LOG_E(0, "[rx]:TRX_DATA_HEAD_ERROR");
        return TRX_DATA_HEAD_ERROR;
    }

    //check length
    if (length != buffer[3])
    {
        CVT213X_TRX_LOG_E(1, "[rx]:TRX_DATA_SIZE_ERROR, rx length:0x%02x, buffer[3]:0x%02x", length, buffer[3]);
        return TRX_DATA_SIZE_ERROR;
    }

    //check length and crc
    for (i = 3; i < buffer[3]; ++i)
    {
        cksum ^= buffer[i]; //buffer[2]~buffer[len-1]
    }
    if (cksum)
    {
        CVT213X_TRX_LOG_E(1, "[rx]:fail on cksum:0x%02x", cksum);
        return TRX_DATA_CHECK_ERROR;
    }

    //set trx handle state
    CVT213X_TRX_LOG_D(1, "[rx]:g_trx_handle_busy_state:%d", g_trx_handle_busy_state);
    if (TRX_ALL_FINISH == g_trx_handle_busy_state)
    {
        g_trx_handle_busy_state |= TRX_Handle_BUSY;
        g_busy_cnt = 0;
        CVT213X_TRX_LOG_D(0, "[rx]:valid to handle rx cmd");
        return TRX_DATA_CHECK_PASS;
    }
    else
    {
        g_busy_cnt++;
        if (TWS_MSG_TEST_MODE_STATUS == buffer[2] || g_busy_cnt > 1)
        {
            CVT213X_TRX_LOG_D(0, "[rx]:force to handle rx cmd");
            return TRX_DATA_CHECK_PASS;
        }
        CVT213X_TRX_LOG_W(0, "[rx]:busy on handling cmd");
        return TRX_DATA_CHECK_ERROR;
    }
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_task_trx_data_checker(TWS_U16 length, TWS_U8 *buffer)
{
    trx_check_status_e cmd_state_flag;
    TWS_U8 i = 0;
    cmd_state_flag = cvt213x_trx_cmd_check((TWS_U8)length, (TWS_U8 *)buffer);
    if (TRX_DATA_CHECK_PASS == cmd_state_flag)
    {
        for (i = 0; i < buffer[3]; i++)//save buffer data
        {
            g_rx_buffer[i] = buffer[i];
        }

        CVT213X_TRX_LOG_D(1, "[rx]:check pass, cmd:0x%02x", buffer[2]);
        app_cvt213x_trx_uart_rx_packet_init();
        return TRUE;
    }
    app_cvt213x_trx_uart_rx_packet_init();
    return FALSE;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_task_trx_data_proc(void)
{
    cvt213x_trx_cmd_handler(g_rx_buffer);
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_task_trx_irq_proc(void)
{
    TWS_U8 rd_irq[2];

    CVT213X_TRX_LOG_D(0, "cvt213x_task_trx_irq_proc() enter");

    if (g_data_cnt)
    {
        cvt213x_i2c_read_irq(CVT213X_TRX_SLE, rd_irq);
        cvt213x_i2c_clear_int(CVT213X_TRX_SLE);

        //only valid to read useful/avg/diff/cc data after sampling done
        if (rd_irq[0] & TWS_IRQ_CONVDONE)
        {
            if (g_data_cnt < WAIT_IRQ_MODE_WRITE)
            {
                g_data_cnt--;
                CVT213X_TRX_LOG_D(1, "req_cnt ok=%d", g_data_cnt);

                cvt213x_task_trx_delay_read();

                //read finished
                if (0 == g_data_cnt)
                {
                    if (TWS_MSG_GET_DIFF <= g_rx_buffer[2])
                    {
                        cvt213x_message_send((tws_msg_type_e)(g_rx_buffer[2] + 1), g_rx_buffer);
                    }
                }
            }
        }

        //only valid to write register after cvt213x enter idle state
        if (rd_irq[0] & TWS_IRQ_READY)
        {
            if (WAIT_IRQ_MODE_WRITE == g_data_cnt)
            {
                g_data_cnt = 0;

                cvt213x_task_trx_delay_write();

                //read register back for ack packet
                cvt213x_util_i2c_read(CVT213X_TRX_SLE, g_reg_info.reg, &g_tx_buffer[6], 4);
                cvt213x_message_send(TWS_MSG_R_I2C_WRITE, g_rx_buffer);
            }
        }
    }
    else
    {
        cvt213x_i2c_clear_int(CVT213X_TRX_SLE);
    }
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_event_set(tws_event_e event)
{
    tws_event_e ied_event = (tws_event_e)(event & TWS_IED_EVENT_MSK);
    tws_event_e event_bk = g_event_status; //backup event/status
    g_event_status = event; //update event/status

    //send event/status to cvt213x app in show mode
    if (event != TWS_EVENT_NONE)
    {
        if (g_test_mode_status == TRX_SHOW_MODE_EN)
        {
            cvt213x_message_send(TWS_MSG_R_GET_EVENT, g_rx_buffer);
        }
    }

    //recover IED status
    if ((ied_event != TWS_EVENT_IED_ON) && (ied_event != TWS_EVENT_IED_OFF))
    {
        g_event_status = event_bk;
    }
}
#endif

