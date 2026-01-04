/*******************************************************************************
 * Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
 *
 * File:         app_cvt213x_main.c
 * Description:
 * Version：      V2.0
 * Date：         2021-11-16
 * Author：       CVA Software Team
 *******************************************************************************/

/*******************************************************************************
 * 1.Included header files
 *******************************************************************************/
#include <zephyr/logging/log.h>

/* Register Zephyr log module used by the CVT213X app shim. Define a guard
 * so the header's LOG_MODULE_DECLARE doesn't re-declare the module variables
 * in this same translation unit. */
#define APP_CVT213X_REGISTER_LOG_MODULE

#include "./lib/api/cva_tws_api.h"
#include "app_cvt213x_main.h"
#include "app_cvt213x_porting.h"

LOG_MODULE_REGISTER(app_cvt213x_main, LOG_LEVEL_INF);
/*******************************************************************************
 * 2.Private constant and macro definitions using #define
 *******************************************************************************/

/*******************************************************************************
 * 3.Private enumerations, structures and unions using typedef
 *******************************************************************************/

/*******************************************************************************
 * 4.Static variables
 *******************************************************************************/

/*******************************************************************************
 * 5.Global variable or extern global variabls/functions
 *******************************************************************************/
TWS_U8        g_cvt213x_sleep_flag = 0;
extern TWS_U8 cvt213x_tone_flag;

#if CVT213X_TRX_EN
#define RX_BUF_SIZE 16
static TWS_U8 g_rx_buffer[RX_BUF_SIZE];
static TWS_U8 bufIndex = 0;
static TWS_U8 bufLen   = 0;
#endif
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
TWS_S32 app_cvt213x_irq_handler(tws_chip_index_e chipIndex)
{
    tws_event_e event = TWS_EVENT_NONE;

    // CVT213X_APP_LOG_D(1, "chip%d, app_cvt213x_irq_handler(): enter", chipIndex);

#if CVT213X_TRX_EN
    // mp mode handling
    if (cvt213x_get_enter_mp_mode_flag())
    {
        cvt213x_task_trx_irq_proc();
        return 0;
    }
#endif

    event = cvt213x_gesture_process(chipIndex);

#if (CVT213X_IC_TYPE_SELECT != IC_TYPE_CVT2138)
    // TWS_S32 rd_raw[5] = {0};
    // TWS_S32 rd_avg[5] = {0};
    // TWS_S32 rd_diff[5] = {0};
    // cvt213x_i2c_read_phase_raw_data(chipIndex,rd_raw);
    // cvt213x_i2c_read_phase_avg_data(chipIndex,rd_avg);
    // cvt213x_i2c_read_phase_diff_data(chipIndex,rd_diff);
    // CVT213X_APP_LOG_D(5, "raw: %07d, %07d, %07d, %07d, %07d", rd_raw[0], rd_raw[1], rd_raw[2], rd_raw[3], rd_raw[4]);
    // CVT213X_APP_LOG_D(5, "avg: %07d, %07d, %07d, %07d, %07d", rd_avg[0], rd_avg[1], rd_avg[2], rd_avg[3], rd_avg[4]);
    // CVT213X_APP_LOG_D(5, "diff: %07d, %07d, %07d, %07d, %07d", rd_diff[0], rd_diff[1], rd_diff[2], rd_diff[3],
    // rd_diff[4]);
#else
    // TWS_S32 rd_raw[8] = {0};
    // TWS_S32 rd_avg[8] = {0};
    // TWS_S32 rd_diff[8] = {0};
    // cvt213x_i2c_read_phase_raw_data(chipIndex,rd_raw);
    // cvt213x_i2c_read_phase_avg_data(chipIndex,rd_avg);
    // cvt213x_i2c_read_phase_diff_data(chipIndex,rd_diff);
    // CVT213X_APP_LOG_D(8, "raw: %07d, %07d, %07d, %07d, %07d, %07d, %07d, %07d", rd_raw[0], rd_raw[1], rd_raw[2],
    // rd_raw[3], rd_raw[4], rd_raw[5], rd_raw[6], rd_raw[7]); CVT213X_APP_LOG_D(8, "avg: %07d, %07d, %07d, %07d, %07d,
    // %07d, %07d, %07d", rd_avg[0], rd_avg[1], rd_avg[2], rd_avg[3], rd_avg[4], rd_avg[5], rd_avg[6], rd_avg[7]);
    // CVT213X_APP_LOG_D(8, "diff: %07d, %07d, %07d, %07d, %07d, %07d, %07d, %07d", rd_diff[0], rd_diff[1], rd_diff[2],
    // rd_diff[3], rd_diff[4], rd_diff[5], rd_diff[6], rd_diff[7]);
#endif

    if (event != TWS_EVENT_NONE)
    {
#if CVT213X_TRX_EN
        tws_event_e ied_tk_event = (tws_event_e)(event & TWS_EVENT_MSK);
        cvt213x_event_set(ied_tk_event);
#endif

        app_cvt213x_event_handler(event);

        // if (event == TWS_EVENT_FIX_COMPENSATION)
        // {
        //     cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_COMP);
        // }
    }

    // CVT213X_APP_LOG_D(1, "chip%d, app_cvt213x_irq_handler(): end", chipIndex);
    return 0;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S32 app_cvt213x_polling_handler(tws_chip_index_e chipIndex)
{
    tws_event_e event = TWS_EVENT_NONE;

    event = cvt213x_ied_process(chipIndex);

    if (event != TWS_EVENT_NONE)
    {
#if CVT213X_TRX_EN
        tws_event_e ied_tk_event = (tws_event_e)(event & TWS_EVENT_MSK);
        cvt213x_event_set(ied_tk_event);
#endif

        app_cvt213x_event_handler(event);
    }

    return 0;
}

#if CVT213X_TRX_EN
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S32 app_cvt213x_trx_connected(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_trx_connected");
    cvt213x_task_trx_connected_proc();
    return 0;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S32 app_cvt213x_trx_disconnected(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_trx_disconnected");
    cvt213x_task_trx_disconnected_proc();
    return 0;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
static TWS_BOOL app_cvt213x_trx_data_checker(TWS_U16 length, TWS_U8* buffer)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_trx_data_checker");

    return cvt213x_task_trx_data_checker(length, buffer);
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S32 app_cvt213x_trx_data_handler(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_trx_data_handler");
    cvt213x_task_trx_data_proc();
    return 0;
}
#endif

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_scheduler_handler(EARBUD_CVT213X_ID id)
{
    switch (id)
    {
        case APP_MODUAL_CVT213X_IRQ:
            app_cvt213x_irq_handler(TWS_CHIP_0);
            break;

#if DUAL_CVT213X_ENABLE
        case APP_MODUAL_CVT213X_IRQ_2ND:
            app_cvt213x_irq_handler(TWS_CHIP_1);
            break;
#endif

#if CVT213X_TRX_EN
        case APP_MODUAL_CVT213X_TRX_START:
            app_cvt213x_trx_connected();
            break;

        case APP_MODUAL_CVT213X_TRX_END:
            app_cvt213x_trx_disconnected();
            break;

        case APP_MODUAL_CVT213X_TRX_DATA:
            app_cvt213x_trx_data_handler();
            break;
#endif

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
TWS_U8 app_cvt213x_check_i2c_connect(tws_chip_index_e chipIndex)
{
    TWS_U8 i2c_rd[1] = {0};

    app_cvt213x_i2c_read_reg(chipIndex, 0x0014, i2c_rd, 1);  // read i2c addr reg

    if ((i2c_rd[0] == 0x28) || (i2c_rd[0] == 0x2C))
    {
        CVT213X_APP_LOG_E(2, "chip%d:cvt213x i2c connect ok:i2c addr=0x%x", chipIndex, i2c_rd[0]);
        return TRUE;
    }
    else
    {
        CVT213X_APP_LOG_E(2, "chip%d: cvt213x i2c connect fail:i2c addr=0x%x", chipIndex, i2c_rd[0]);
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
static void app_cvt213x_init_board(void)
{
    TWS_S8 ret = -1;

    CVT213X_APP_LOG_D(0, "app_cvt213x_init_board() enter");

    app_cvt213x_i2c_init();
    app_cvt213x_irq_init();
#if CVT213X_TRX_EN
    app_cvt213x_trx_init();
#endif

    app_cvt213x_check_i2c_connect(TWS_CHIP_0);
#if CVT213X_HOST_SLEEP_EN
    if (app_cvt213x_is_in_host_sleep_mode(TWS_CHIP_0))
    {
        app_cvt213x_prepare_host_quit_sleep(TWS_CHIP_0);
    }
    else
#endif
    {
        cvt213x_sleep(TWS_CHIP_0);

        ret = cvt213x_init(TWS_CHIP_0);
        if (ret)
        {
            CVT213X_APP_LOG_E(1, "chip0 cvt213x write reg failed, ret = %d", ret);
        }
        else
        {
            CVT213X_APP_LOG_D(0, "chip0 cvt213x write reg ok");
        }
    }

#if DUAL_CVT213X_ENABLE
#if CVT213X_IED_TK_SEPARATE_EN
    app_cvt213x_check_i2c_connect(TWS_CHIP_1);
    ret = cvt213x_init(TWS_CHIP_1);
    if (ret)
    {
        CVT213X_APP_LOG_E(1, "chip1 cvt213x write reg failed, ret = %d", ret);
    }
    else
    {
        CVT213X_APP_LOG_D(0, "chip1 cvt213x write reg ok");
    }
#else
    cvt213x_sleep(TWS_CHIP_1);
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
void app_cvt213x_main_init(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_main_init() enter");

    CVT213X_APP_LOG_D(1, "cvt213x driver version is %s", cvt213x_get_version());

    app_cvt213x_scheduler_init();

    app_cvt213x_init_board();
}

#if CVT213X_TRX_EN
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_trx_spp_connect(void)
{
    app_cvt213x_scheduler_put_event(APP_MODUAL_CVT213X_TRX_START);
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_trx_spp_disconnect(void)
{
    app_cvt213x_scheduler_put_event(APP_MODUAL_CVT213X_TRX_END);
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_trx_spp_rx_handler(TWS_U16 length, TWS_U8* buffer)
{
    cvt213x_util_trx_set_tx_port(TWS_TRX_PORT_SPP);
    if (app_cvt213x_trx_data_checker(length, buffer))
    {
        app_cvt213x_scheduler_put_event(APP_MODUAL_CVT213X_TRX_DATA);
    }
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_trx_uart_rx_handler(TWS_U16 length, TWS_U8* buffer)
{
    cvt213x_util_trx_set_tx_port(TWS_TRX_PORT_UART);
    if (app_cvt213x_trx_data_checker(length, buffer))
    {
        app_cvt213x_scheduler_put_event(APP_MODUAL_CVT213X_TRX_DATA);
    }
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note uart receive all data,then put in app_cvt213x_rx_packet_parse_all
 ****************************************************************/
void app_cvt213x_rx_packet_parse_all(TWS_U8* buf, TWS_U16 len)
{
    for (int i = 0; i < len; i++)
    {
        app_cvt213x_trx_uart_rx_packet_parse(buf[i]);
    }
}
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note uart receive one byte,then put in app_cvt213x_rx_packet_parse
 ****************************************************************/
void app_cvt213x_trx_uart_rx_packet_parse(TWS_U8 data)
{
    CVT213X_APP_LOG_D(1, "app_cvt213x_trx_uart_rx_packet_parse enter data:%x\n", data);
    TWS_U8 recv_valid = 0;

    if ((bufIndex == 0) && (data == 0xA5))  // 表头
    {
        recv_valid = 1;
    }
    else if ((bufIndex == 1) && (data == 0xA5))  // 表头
    {
        recv_valid = 1;
    }
    else if (bufIndex == 2)  // CMD位
    {
        recv_valid = 1;
    }
    else if (bufIndex == 3)  // 数据位
    {
        bufLen = data;  // 数据长度
        if (bufLen <= RX_BUF_SIZE)
        {
            recv_valid = 1;
        }
    }
    else if (bufIndex < RX_BUF_SIZE)
    {
        if ((bufLen != 0) && (bufLen > bufIndex))
        {
            recv_valid = 1;
        }
    }

    if (recv_valid)
    {
        g_rx_buffer[bufIndex] = data;
        bufIndex++;
    }
    else
    {
        CVT213X_APP_LOG_E(0, "rx data is oversize\n");
    }

    CVT213X_APP_LOG_D(2, "bufLen:%d  bufIndex=%d\n", bufLen, bufIndex);
    if ((bufLen == bufIndex) && (bufLen != 0))
    {
        app_cvt213x_trx_uart_rx_handler(bufLen, g_rx_buffer);
    }
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_trx_uart_rx_packet_init(void)
{
    memset(g_rx_buffer, 0x00, RX_BUF_SIZE);
    bufIndex = 0;
    bufLen   = 0;
}
#endif

#if CVT213X_HOST_SLEEP_EN
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_U8 app_cvt213x_is_in_host_sleep_mode(tws_chip_index_e chipIndex)
{
    TWS_U8 rd_data[1] = {0};

    app_cvt213x_i2c_init();

#if 0  // check touch event , close irq
    app_cvt213x_i2c_read_reg(chipIndex, 0x0000, rd_data, 1);
    if (rd_data[0] & 0x02)
    {
        return TRUE;
    }
#else  // check cvt213x alive
    app_cvt213x_i2c_read_reg(chipIndex, 0x002e, rd_data, 1);
    if (rd_data[0] != 0x00)
    {
        CVT213X_LIB_LOG_E(1, "exception happend! reg[0x002e]=%02x", rd_data[0]);
        return TRUE;
    }
#endif

    return FALSE;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_prepare_host_enter_sleep(tws_chip_index_e chipIndex)
{
    if (cvt213x_get_scan_mode(chipIndex) != HOST_SLEEP_MODE)
    {
        cvt213x_scan_mode_prepare_switch_to_host_sleep_mode(chipIndex);
    }
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_prepare_host_quit_sleep(tws_chip_index_e chipIndex)
{
    CVT213X_APP_LOG_E(0, "app_cvt213x_prepare_host_quit_sleep() enter");

    cvt213x_scan_mode_prepare_switch_to_host_wakeup_mode(chipIndex);
}
#endif

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_calibration_speed_up(void)
{
    TWS_U8 loop_cnt = 0;
    while (cvt213x_get_scan_mode(TWS_CHIP_0) != DOZE_MODE)
    {
        if (!app_cvt231x_irq_get_leavel(TWS_CHIP_0))
        {
            g_cvt213x_irq_flag     = 1;
            g_cvt213x_polling_flag = 0;
            app_cvt213x_irq_handler(TWS_CHIP_0);
        }
        app_cvt213x_delay(5);

        loop_cnt++;
        if (loop_cnt >= 40)
        {
            CVT213X_APP_LOG_E(0, "cvt213x_calibration timeout!!!!!!");
            break;
        }
    }
}
#if CVT213X_SETUP_FUN
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_manual_reset_host(tws_chip_index_e chipIndex)
{
    cvt213x_manual_reset_host(chipIndex);
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note save ear offset and base to flash
 ****************************************************************/
void app_cvt213x_save_offset_to_flash(void)
{
    CVT213X_APP_LOG_E(1, "app_cvt213x_save_offset_to_flash() enter");

    {
        app_cvt213x_manual_reset_host(TWS_CHIP_0);
        cvt213x_set_setup_info_to_flash();
    }
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_startup_init(void)
{
    CVT213X_APP_LOG_E(0, "app_cvt213x_startup_init() enter");

    cvt213x_init(TWS_CHIP_0);
    app_cvt213x_calibration_speed_up();
}
#endif

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note cvt213x init func,call this func in poweron stage
 ****************************************************************/
void app_cvt213x_sys_init(void)
{
    CVT213X_APP_LOG_E(0, "app_cvt213x_sys_init() enter");

    // app_cvt213x_poweron(TRUE);
#if CVT213X_SETUP_FUN
    TWS_U8 init_state = 0;
    cvt213x_is_earphone_in_box_state_set(app_cvt213x_get_inbox_state_det_gpio());  // get ephone state if in chargebox
    init_state = cvt213x_is_earphone_in_box_state_get();
    CVT213X_APP_LOG_E(1, "start cvt213x sys_init inbox_state =%d", init_state);
#endif

    app_cvt213x_main_init();  // cvt213x initial
    app_cvt213x_calibration_speed_up();

#if CVT213X_SETUP_FUN
    if (init_state)
    {
        cvt213x_is_earphone_in_box_state_set(app_cvt213x_get_inbox_state_det_gpio());
        CVT213X_APP_LOG_E(1, "after cvt213x sys_init inbox_state =%d", app_cvt213x_get_inbox_state_det_gpio());

        if (!cvt213x_is_earphone_in_box_state_get())
        {
            cvt213x_sleep(TWS_CHIP_0);
            app_cvt213x_startup_init();  // cvt213x init outbox,read ear offset and base calc
        }
    }
#endif

    cvt213x_tone_flag = 0;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note earphone state: close -- open or close---outobx ,call this func
 ****************************************************************/
void app_cvt213x_wakeup(void)
{
    CVT213X_APP_LOG_E(0, "app_cvt213x_wakeup() enter");

    if (g_cvt213x_sleep_flag == 1)
    {
        g_cvt213x_sleep_flag = 0;
#if CVT213X_SETUP_FUN
        TWS_U8 init_state = 0;
        cvt213x_is_earphone_in_box_state_set(
            app_cvt213x_get_inbox_state_det_gpio());  // get ephone state if in chargebox
        init_state = cvt213x_is_earphone_in_box_state_get();
        CVT213X_APP_LOG_E(1, "start cvt213x wakeup inbox_state =%d", init_state);
#endif
        cvt213x_wakeup(TWS_CHIP_0);
        app_cvt213x_calibration_speed_up();

#if CVT213X_SETUP_FUN
        if (init_state)
        {
            cvt213x_is_earphone_in_box_state_set(app_cvt213x_get_inbox_state_det_gpio());
            CVT213X_APP_LOG_E(1, "after cvt213x wakeup inbox_state =%d", app_cvt213x_get_inbox_state_det_gpio());

            if (!cvt213x_is_earphone_in_box_state_get())
            {
                cvt213x_sleep(TWS_CHIP_0);
                app_cvt213x_startup_init();
            }
        }
#endif
    }

    cvt213x_tone_flag = 0;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note earphone state: inbox -- close ,call this func
 ****************************************************************/
void app_cvt213x_sleep(void)
{
    CVT213X_APP_LOG_E(0, "app_cvt213x_sleep() enter");
#if CVT213X_SETUP_FUN
    cvt213x_is_earphone_in_box_state_set(app_cvt213x_get_inbox_state_det_gpio());
    app_cvt213x_save_offset_to_flash();
#endif
    cvt213x_sleep(TWS_CHIP_0);
    g_cvt213x_sleep_flag = 1;
}
