/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_platform.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

#ifndef _CVA_TWS_PLATFORM_H_
#define _CVA_TWS_PLATFORM_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
* 1.Included files
*******************************************************************************/

/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/
#define PLATFORM_INNER_VERSION  "V2.5.0.0-20240925"

#define MAX_TIME_OUT_MS_WAIT_IRQ        256            //i2c IRQ最大等待超时时间256ms

/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/

/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/

/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/
//sleep mode
void cvt213x_set_init_state(tws_chip_index_e chipIndex, TWS_U8 status);
TWS_U8 cvt213x_get_init_state(tws_chip_index_e chipIndex);

//platform
void cvt213x_util_set_init_flag(tws_chip_index_e chipIndex, tws_work_status_e status);
void cvt213x_scan_mode_init(tws_chip_index_e chipIndex);
void cvt213x_scan_mode_prepare_switch(tws_chip_index_e chipIndex, enum_scan_mode new_mode);
tws_ret_e cvt213x_scan_mode_switch(tws_chip_index_e chipIndex, enum_scan_mode cur_mode, enum_scan_mode new_mode);
tws_ret_e cvt213x_check_idle(tws_chip_index_e chipIndex);
TWS_BOOL cvt213x_smt_check_channel(tws_chip_index_e chipIndex);

#ifdef __cplusplus
}
#endif

#endif

