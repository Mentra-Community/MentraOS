/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_api.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

#ifndef _CVA_TWS_API_H_
#define _CVA_TWS_API_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
* 1.Included files
*******************************************************************************/
#include "cva_tws_sys_def.h"

#if DUAL_CVT213X_ENABLE
    #include "cva_tws_sys_def_2nd_chip.h"
#endif

/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/
#ifndef NULL
    #define NULL             0
#endif

#ifndef TRUE
    #define TRUE             1
#endif

#ifndef FALSE
    #define FALSE            0
#endif

#define CVT213X_UNUSED(p) ((void)(p))
/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/

/* 手势识别函数 返回类型 */
typedef enum
{
    TWS_EVENT_NONE = 0,                         // 0 默认无操作
    TWS_EVENT_SINGLE_CLICK,                     // 1 单击
    TWS_EVENT_DOUBLE_CLICK,                     // 2 双击
    TWS_EVENT_TRIPLE_CLICK,                     // 3 三击
    TWS_EVENT_FOURTH_CLICK,                     // 4 四击
    TWS_EVENT_FIFTH_CLICK,                      // 5 五击
    TWS_EVENT_SIXTH_CLICK,                      // 6 六击
    TWS_EVENT_SEVENTH_CLICK,                    // 7 七击
    TWS_EVENT_EIGHTH_CLICK,                     // 8 八击
    TWS_EVENT_LONG_PRESS,                       // 9 长按
    TWS_EVENT_LONGLONG_PRESS,                   // 10 长长按
    TWS_EVENT_SINGLE_CLICK_AND_LONG_PRESS,      // 11 单击 + 长按
    TWS_EVENT_DOUBLE_CLICK_AND_LONG_PRESS,      // 12 双击 + 长按
    TWS_EVENT_TRIPLE_CLICK_AND_LONG_PRESS,      // 13 三击 + 长按
    TWS_EVENT_FOURTH_CLICK_AND_LONG_PRESS,      // 14 四击 + 长按
    TWS_EVENT_FIFTH_CLICK_AND_LONG_PRESS,       // 15 五击 + 长按
    TWS_EVENT_SIXTH_CLICK_AND_LONG_PRESS,       // 16 六击 + 长按
    TWS_EVENT_SEVENTH_CLICK_AND_LONG_PRESS,     // 17 七击 + 长按
    TWS_EVENT_EIGHTH_CLICK_AND_LONG_PRESS,      // 18 八击 + 长按
    TWS_EVENT_SLIDE_UP,                         // 19 上划
    TWS_EVENT_SLIDE_DOWN,                       // 20 下划
    TWS_EVENT_FIX_COMPENSATION,                 // 21 长按超时
    TWS_EVENT_LONG_PRESS_UP = 22,               //长按抬起
    TWS_EVENT_IED_ON = 0x40,                    // 入耳
    TWS_EVENT_IED_OFF = 0x80,                   // 出耳
} tws_event_e;

#define TWS_IED_EVENT_MSK       (0xC0)
#define TWS_TK_EVENT_MSK        (0x3F)
#define TWS_EVENT_MSK           (TWS_IED_EVENT_MSK|TWS_TK_EVENT_MSK)

/* 初始化函数和注册回调函数 返回类型 */
typedef enum
{
    TWS_RET_OK                    =  0,   //通信OK
    TWS_RET_UNINIT_ERROR          = -1,   //未初始化
    TWS_RET_CHECKSUM_ERROR        = -2,   //校验错
    TWS_RET_INVALID_COMMAND       = -3,   //无效命令
    TWS_RET_INVALID_PARAM         = -4,   //无效参数
    TWS_RET_NULL_POINTER          = -5,   //空指针
    TWS_RET_ALLO_MEM_ERROR        = -6,   //内存申请出错
    TWS_RET_TIME_OUT              = -7,   //超时
    TWS_RET_NEED_RESET            = -8,   //错误需要复位模组
    TWS_RET_I2C_IO_ERROR          = -9,   //I2C引脚错误 需要检查模组
    TWS_RET_IRQ_IO_ERROR          = -10,  //IRQ引脚错误 需要检查模组

    TWS_RET_NOT_USED              = -99,  //用作初始化
} tws_ret_e;

//cva_tws_util.c
typedef void (*tws_delay_cb)(TWS_U32 Delay);
typedef TWS_S32 (*cvt213x_i2c_cb)(tws_chip_index_e chipIndex, TWS_U16 reg_addr, TWS_U8 *buff, TWS_U32 size);
typedef TWS_S32 (*tws_trx_tx)(TWS_U8 *packet, TWS_U16 len);
typedef TWS_U32 (*tws_get_current_ms)(void);
typedef TWS_U8 (*tws_irq_get_level)(tws_chip_index_e chipIndex);

typedef TWS_S8 (*tws_flash_write)(TWS_U8 buf[], TWS_U8 len);
typedef TWS_S8 (*tws_flash_read)(TWS_U8 buf[], TWS_U8 len);
typedef TWS_S8 (*tws_setup_flash_write)(TWS_U8 buf[], TWS_U8 len);
typedef TWS_S8 (*tws_setup_flash_read)(TWS_U8 buf[], TWS_U8 len);

/* 寄存器初始化 */
typedef struct
{
    TWS_U16  reg;                                 // 寄存器地址
    TWS_U32  val;                                 // 寄存器值
} tws_reg_t;

/* 手势变量初始化 */
typedef struct
{
    TWS_U16 long_push_thr;                        // long-press frames threshold
    TWS_U8 long_push_repeat_en;                   // long-press repeat report enable
    TWS_U16 long_push_repeat_thr;                 // long-press repeat cycle
    TWS_U16 click_thr;                             // gap frames threshold
    TWS_U8 push_thr;                              // push debounce count
    TWS_U8 release_thr;                           // release debounce count
    TWS_U8 slide_thr;                             // slide distance threshold
    TWS_U8 slide_repeat_en;                       // slide repeat report enable
    TWS_U16 slide_repeat_thr;                     // slide repeat cycle
    TWS_U8 click_num_en;                          // click number event enable
    TWS_U8 click_and_long_press_en;               // click and long press event enable
    TWS_U16 click_and_long_press_thr;             // long press threshold for click and long press event
} cvt213x_gesture_cfg;

/* 量产相关寄存器 */
union mult_var
{
    TWS_S32 u32_data;
    TWS_U8  u8_buff[4];
};

typedef enum
{
    TWS_CMD_START = 0x00,   //开启扫描
    TWS_CMD_RESET,          //复位
    TWS_CMD_COMP,           //开启校准
    TWS_CMD_ENTER_SLEEP,    //进入休眠
    TWS_CMD_EXITS_SLEEP,    //退出休眠
    TWS_CMD_IDLE,           //进入Idle mode
    TWS_CMD_SCAN,           //恢复扫描

    TWS_CMD_MAX, 
} enum_tws_cmd_e;

typedef enum
{
    TWS_TRX_PORT_SPP,
    TWS_TRX_PORT_UART,

    TWS_TRX_PORT_MAX_NUM,
} enum_tws_trx_port_e;

typedef enum
{
    CVT_POWER_ON = 0x0,
    NEED_INIT,
    INIT_DONE,
} tws_work_status_e;

typedef struct
{
    TWS_S32 raw_mid_buf[3];
    TWS_S32 ref_mid_buf[3];
    TWS_S32 raw;
    TWS_S32 base;
    TWS_S32 diff;
    TWS_U8  isInEar; 
    TWS_U8  dropCnt;
} st_ied_flt, *p_st_ied_flt;

/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/

/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/
//platform.c
tws_ret_e cvt213x_init(tws_chip_index_e chipIndex);
void cvt213x_sleep(tws_chip_index_e chipIndex);
TWS_S32 cvt213x_wakeup(tws_chip_index_e chipIndex);
enum_scan_mode cvt213x_get_scan_mode(tws_chip_index_e chipIndex);
enum_scan_mode cvt213x_get_next_scan_mode(tws_chip_index_e chipIndex);
void cvt213x_scan_mode_prepare_switch_to_host_sleep_mode(tws_chip_index_e chipIndex);
void cvt213x_scan_mode_prepare_switch_to_host_wakeup_mode(tws_chip_index_e chipIndex);
void  cvt213x_i2c_read_phase_raw_data(tws_chip_index_e chipIndex, TWS_S32 *rd_raw);
void  cvt213x_i2c_read_phase_avg_data(tws_chip_index_e chipIndex, TWS_S32 *rd_avg);
void  cvt213x_i2c_read_phase_diff_data(tws_chip_index_e chipIndex, TWS_S32 *rd_diff);
void  cvt213x_get_phase_diff_data(tws_chip_index_e chipIndex,TWS_U8 ph_channel,TWS_S32 *rd_diff);
void  cvt213x_i2c_read_comp_data(tws_chip_index_e chipIndex, TWS_S32 *rd_raw);
char *cvt213x_get_version(void);
tws_work_status_e cvt213x_util_get_init_flag(tws_chip_index_e chipIndex);

//i2c.c
void  cvt213x_i2c_send_cmd(tws_chip_index_e chipIndex, const enum_tws_cmd_e cmd);
void  cvt213x_i2c_clear_int(tws_chip_index_e chipIndex);
void  cvt213x_i2c_read_touch_state(tws_chip_index_e chipIndex, TWS_U8 *rd_data);

//util.c
void cvt213x_util_trx_set_tx_port(enum_tws_trx_port_e port);

//gesture.c
tws_event_e cvt213x_gesture_process(tws_chip_index_e chipIndex);
tws_event_e cvt213x_ied_process(tws_chip_index_e chipIndex);
void cvt213x_gesture_cfg_update_fix_compensation(tws_chip_index_e chipIndex, TWS_U16 thr);
void cvt213x_gesture_detect_set_push(tws_chip_index_e chipIndex, TWS_U16 push);
void cvt213x_gesture_detect_set_release(tws_chip_index_e chipIndex, TWS_U16 release);
void cvt213x_gesture_detect_set_long(tws_chip_index_e chipIndex, TWS_U8 flag);
void cvt213x_gesture_detect_set_gap(tws_chip_index_e chipIndex, TWS_U8 flag);
TWS_U8 cvt213x_ied_get_last_prox_state(void);
void cvt213x_gesture_var_init(tws_chip_index_e chipIndex);
void cvt213x_is_earphone_in_box_state_set(TWS_U8 state);
TWS_U8 cvt213x_is_earphone_in_box_state_get(void);
void cvt213x_manual_reset_host(tws_chip_index_e chipIndex);
TWS_BOOL cvt213x_set_setup_info_to_flash(void);

//dongle.c
TWS_BOOL cvt213x_get_enter_mp_mode_flag(void);
void cvt213x_event_set(tws_event_e event);
void cvt213x_task_trx_irq_proc(void);
void cvt213x_task_trx_connected_proc(void);
void cvt213x_task_trx_disconnected_proc(void);
TWS_BOOL cvt213x_task_trx_data_checker(TWS_U16 length, TWS_U8 *buffer);
void cvt213x_task_trx_data_proc(void);

//proting.c
void app_cvt213x_irq_enable(void);
void app_cvt213x_irq_disable(void);

//main.c

#ifdef __cplusplus
}
#endif

#endif

