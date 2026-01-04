/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         app_cvt213x_main.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

#ifndef _APP_CVT213X_MAIN_H_
#define _APP_CVT213X_MAIN_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
* 1.Included files
*******************************************************************************/
#include "./lib/api/cva_tws_api.h"

/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/

/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/

/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/

/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/
TWS_S32 app_cvt213x_irq_handler(tws_chip_index_e chipIndex);
TWS_S32 app_cvt213x_polling_handler(tws_chip_index_e chipIndex);
TWS_S32 app_cvt213x_trx_connected(void);
TWS_S32 app_cvt213x_trx_disconnected(void);
TWS_S32 app_cvt213x_trx_data_handler(void);

//porting TODO: call app_cvt213x_scheduler_handler in cvt213x thread handler context
void app_cvt213x_scheduler_handler(EARBUD_CVT213X_ID id);

//porting TODO: call app_cvt213x_scheduler_put_event in IRQ/TRX-connect/TRX-disconnect/TRX-rx ISR context
void app_cvt213x_scheduler_put_event(EARBUD_CVT213X_ID id);

//porting TODO: call app_cvt213x_main_init for initilizing cvt213x module
TWS_U8 app_cvt213x_check_i2c_connect(tws_chip_index_e chipIndex);
void app_cvt213x_main_init(void);
void app_cvt213x_sys_init(void);
void app_cvt213x_wakeup(void);
void app_cvt213x_sleep(void);
void app_cvt213x_calibration_speed_up(void);

//porting TODO:(optional) call below function in SPP interface
void app_cvt213x_trx_spp_connect(void);
void app_cvt213x_trx_spp_disconnect(void);
void app_cvt213x_trx_spp_rx_handler(TWS_U16 length, TWS_U8 *buffer);

//porting TODO:(optional) call below function in UART interface
void app_cvt213x_trx_uart_rx_handler(TWS_U16 length, TWS_U8 *buffer);
void app_cvt213x_rx_packet_parse_all(TWS_U8 *buf, TWS_U16 len);
void app_cvt213x_trx_uart_rx_packet_parse(TWS_U8 data);
void app_cvt213x_trx_uart_rx_packet_init(void);

#if CVT213X_HOST_SLEEP_EN
//porting TODO:(optional) call app_cvt213x_is_in_host_sleep_mode when host startup to check if host is wakeup by gesture event
TWS_U8 app_cvt213x_is_in_host_sleep_mode(tws_chip_index_e chipIndex);

//porting TODO:(optional) call app_cvt213x_prepare_host_enter_sleep in app_cvt213x_event_handler
void app_cvt213x_prepare_host_enter_sleep(tws_chip_index_e chipIndex);
void app_cvt213x_prepare_host_quit_sleep(tws_chip_index_e chipIndex);
#endif

#if CVT213X_SETUP_FUN
void app_cvt213x_startup_init(void);
void app_cvt213x_save_offset_to_flash(void);
#endif
#ifdef __cplusplus
}
#endif

#endif

