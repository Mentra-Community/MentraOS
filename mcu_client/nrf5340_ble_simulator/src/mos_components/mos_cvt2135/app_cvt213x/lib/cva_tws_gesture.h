/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_gesture.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

#ifndef _CVA_TWS_GESTURE_H_
#define _CVA_TWS_GESTURE_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
 * 1.Included files
 *******************************************************************************/
#include "./api/cva_tws_api.h"

/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/

/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/

/* Frame相关变量 */
typedef struct
{
    enum_scan_mode  scan_mode;
    enum_scan_mode  scan_mode_next;
} st_scan_mode_t;

/* 手势相关变量 */
typedef struct
{
    TWS_U8 status_cur;                                   // 当前帧状态
    TWS_U8 status_last;                                  // 上一帧状态
    TWS_U16 touch_event;                                  // 上报的事件
    TWS_U16 push_count;                                  // 记录下按的帧数
    TWS_U16 release_count;                               // 记录释放的帧数
    TWS_S8 gravity_max;                                 // 重心坐标最大值
    TWS_S8 gravity_min;                                 // 重心坐标最小值
    TWS_U16 slide_repeat_cnt;                            // 滑动续报计时
    TWS_U8 slide_dir;                                    // 滑动方向
    TWS_U8 click_num;                                    // 单击次数
    TWS_U8 last_slide_event;                             
} st_gesture_var;

typedef struct
{
    TWS_U8  cfg_head[4];

    TWS_U16  cca[4];

    TWS_U16  ccb[4];

    TWS_U32  base[4];

    TWS_U8   last_prox_state;

    TWS_U8  cfg_res[3];  //reserved for assignment
} st_setup_info_var;

#define SETUP_INFO_LEN  40
/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/

/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/
void cvt213x_gesture_cfg_update_fix_compensation(tws_chip_index_e chipIndex, TWS_U16 thr);
void cvt213x_gesture_cfg_init(tws_chip_index_e chipIndex);
void cvt213x_gesture_var_init(tws_chip_index_e chipIndex);
void cvt213x_ied_var_init(tws_chip_index_e chipIndex);

void cvt213x_ied_set_last_prox_state(TWS_U8 state);
TWS_U8 cvt213x_ied_get_last_prox_state(void);

TWS_S32 cvt213x_ied_raw_median_filter(TWS_S32 a, TWS_S32 b, TWS_S32 c);
TWS_S32 cvt213x_ied_base_iir_filter(TWS_S32 raw, TWS_S32 base, TWS_U8 pos_coef, TWS_U8 neg_coef);
void cvt213x_setup_update_ph3_thr(TWS_U32 thr);
void cvt213x_setup_update_ph4_thr(TWS_U32 thr);
TWS_S32 cvt213x_setup_algo_get_raw(tws_chip_index_e chipIndex, TWS_U8 ied_chan);
TWS_S32 cvt213x_setup_algo_get_base(tws_chip_index_e chipIndex, TWS_U8 ied_chan);
TWS_S32 cvt213x_setup_algo_get_diff(tws_chip_index_e chipIndex, TWS_U8 ied_chan);
TWS_BOOL cvt213x_setup_info_check_validation(TWS_U8 *cfg_buf, TWS_U16 len);

void cvt213x_setup_detect(tws_chip_index_e chipIndex);
void cvt213x_setup_info_clear(void);
TWS_S32 cvt213x_ied_get_data(tws_chip_index_e chipIndex, TWS_U32 addr);
TWS_U8 cvt213x_setup_get_state(tws_chip_index_e chipIndex, TWS_U8 chan);

TWS_BOOL cvt213x_get_setup_info_from_flash(void);

#ifdef __cplusplus
}
#endif

#endif

