/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_gesture.c
* Description:
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

/*******************************************************************************
* 1.Included header files
*******************************************************************************/
#include "./api/cva_tws_api.h"
#include "cva_tws_gesture.h"
#include "cva_tws_i2c.h"
#include "cva_tws_util.h"
#include "cva_tws_platform.h"
#include "cva_tws_dongle.h"
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(cva_tws_gesture, LOG_LEVEL_INF);
/*******************************************************************************
* 2.Private constant and macro definitions using #define
*******************************************************************************/
#define PUSH             1
#define RELEASE          0

/*******************************************************************************
* 3.Private enumerations, structures and unions using typedef
*******************************************************************************/

/*******************************************************************************
* 4.Static variables
*******************************************************************************/
static TWS_U8 g_last_prox_state = 0x00;

static TWS_U8 g_timeout[TWS_CHIP_NUM] =
{
    0,
#if DUAL_CVT213X_ENABLE
    0
#endif
};

static TWS_U16 g_chip_func[TWS_CHIP_NUM] =
{
    FUNC_TYPE,
#if DUAL_CVT213X_ENABLE
    FUNC_TYPE_2ND
#endif
};

#if IS_TK_ENABLE
static st_gesture_var g_gesture_var[TWS_CHIP_NUM];

static const cvt213x_gesture_cfg g_gesture_cfg[TWS_CHIP_NUM] =
{
    GESTURE_VAR_VAL,
#if DUAL_CVT213X_ENABLE
    GESTURE_VAR_VAL_2ND
#endif
};

static TWS_U8 g_gesture_click_thr[TWS_CHIP_NUM] =
{
    0,
#if DUAL_CVT213X_ENABLE
    0
#endif
};

#if IS_TK_SLIDE_ENABLE
static TWS_U8 g_slide_thr[TWS_CHIP_NUM] =
{
    0,
#if DUAL_CVT213X_ENABLE
    0
#endif
};
#endif

static TWS_U16 g_fix_compensation_thr[TWS_CHIP_NUM] =
{
    FIX_COMPENSATION_THRE,
#if DUAL_CVT213X_ENABLE
    FIX_COMPENSATION_THRE_2ND
#endif
};

#endif

#if IS_IED_ENABLE
static TWS_BOOL isInEar[TWS_CHIP_NUM] =
{
    FALSE,
#if DUAL_CVT213X_ENABLE
    FALSE
#endif
};

#if CVT213X_DROP_STEP_FUN
    static TWS_U32 g_ied_start_time[2] = {0,0};
    static TWS_U32 g_ied_current_timer[2] = {0,0};
    static TWS_S32 g_ied_last_raw[2] = {0,0};
    static TWS_U8  g_ied_drop_flag[2] = {0,0};
    static TWS_U8  g_ied_stop_update_raw_flag[2] ={0,0};
    static TWS_S32 g_ied_drop_raw_mid_buf[3] = {0};
    static TWS_U8  g_ied_getraw_cnt =0;
#endif

#if CVT213X_SETUP_FUN
    #define SETUP_INFO_HEADER1  0x63
    #define SETUP_INFO_HEADER2  0x76
    #define SETUP_INFO_HEADER3  0x61
    #define SETUP_INFO_HEADER4  0x6D

    static TWS_U32 g_phx_in_ear_thr[2] = {CVT213X_SETUP_PH3_THR, CVT213X_SETUP_PH4_THR};
    static TWS_U32 g_phx_ref_use_0c[2] = {0};
    static TWS_U8  g_is_earphone_in_box_flag = 1;
    st_setup_info_var g_setup_info_var = {0};
    static TWS_U8  g_setup_ph = 0x00;
    static TWS_S32 g_box_raw_thr[2] = {PH3_BOX_RAW, PH4_BOX_RAW};
    // static TWS_S32 g_ph_noise_thr[2] = {PH3_NOISE_THR, PH4_NOISE_THR};
    static st_ied_flt g_ied_flt[2] = {{{0}, {0}}};
    static TWS_U8  g_ied_flt_cnt = 0;
    TWS_U8 g_setup_valid = 0;
#endif

static TWS_U8 g_cvt213x_on_cnt = 0;
static TWS_U8 g_cvt213x_off_cnt = 0;
static TWS_U8 g_cvt213x_ph3_off_cnt = 0;
static TWS_U32 g_cvt213x_ph3_inear_state_cnt = 0;
#endif
/*******************************************************************************
* 5.Global variable or extern global variabls/functions
*******************************************************************************/
extern TWS_BOOL g_cvt213x_outbox_flag;

#if IS_TK_ENABLE
    extern TWS_U8 cvt213x_tone_flag;
#endif

#if CVT213X_DROP_STEP_FUN
    static void cvt213x_ied_drop_clear_info(void);
    static void cvt213x_ied_drop_step_calc(tws_chip_index_e chipIndex, TWS_U8 *ph_state, TWS_S32 *ph_rawdata);
#endif
/*******************************************************************************
* 6.Static function prototypes
*******************************************************************************/

#if IS_TK_ENABLE
/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_gesture_cfg_init(tws_chip_index_e chipIndex)
{
    TWS_S8 index = 0;
    TWS_U8 tmpData = 0;

    CVT213X_LIB_LOG_D(0, "cvt213x_gesture_cfg_init() enter");

    g_fix_compensation_thr[chipIndex] = FIX_COMPENSATION_THRE_CHARGE;

    tmpData = g_gesture_cfg[chipIndex].click_num_en;
    g_gesture_click_thr[chipIndex] = 0;
    for (index = 7; index >= 0; index--)
    {
        if ((tmpData >> index) & 0x01)
        {
            g_gesture_click_thr[chipIndex] = index + 1;
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
void cvt213x_gesture_cfg_update_fix_compensation(tws_chip_index_e chipIndex, TWS_U16 thr)
{
    g_fix_compensation_thr[chipIndex] = thr;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_gesture_var_init(tws_chip_index_e chipIndex)
{
    CVT213X_UNUSED(chipIndex);
    CVT213X_LIB_LOG_D(0, "cvt213x_gesture_var_init() enter");
    g_gesture_var[chipIndex].status_cur = RELEASE;
    g_gesture_var[chipIndex].status_last = RELEASE;
    g_gesture_var[chipIndex].touch_event = TWS_EVENT_NONE;
    g_gesture_var[chipIndex].push_count = 0;
    g_gesture_var[chipIndex].release_count = 0;
    g_gesture_var[chipIndex].gravity_max = 0x00;
    g_gesture_var[chipIndex].gravity_min = 0x00;
    g_gesture_var[chipIndex].slide_repeat_cnt = 0x00;
    g_gesture_var[chipIndex].slide_dir = TRUE;
    g_gesture_var[chipIndex].click_num = 0;
    g_gesture_var[chipIndex].last_slide_event = TWS_EVENT_NONE;

#if IS_TK_SLIDE_ENABLE
    g_slide_thr[chipIndex] = g_gesture_cfg[chipIndex].slide_thr;
#endif
}

#if IS_TK_SLIDE_ENABLE
/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static TWS_S8 cvt213x_gesture_gravity_cal(tws_chip_index_e chipIndex, const TWS_U8 proximity_state)
{
    TWS_S8 gravity = 0;
	CVT213X_UNUSED(chipIndex);
#if (CVT213X_IC_TYPE_SELECT != IC_TYPE_CVT2138)
    if ((proximity_state & 0x01) && (!(proximity_state & 0x02)) && (!(proximity_state & 0x04)))      //Phase0 touch, Phase1/2 no touch
    {
        gravity = 0;
    }
    else if ((proximity_state & 0x01) && (proximity_state & 0x02) && (!(proximity_state & 0x04)))    //Phase0/1 touch, Phase2 no touch
    {
        gravity = 1;
    }
    else if ((!(proximity_state & 0x01)) && (proximity_state & 0x02) && (proximity_state & 0x04))    //Phase0 no touch, Phase1/2 touch
    {
        gravity = 3;
    }
    else if (!((proximity_state & 0x01)) && (!(proximity_state & 0x02)) && (proximity_state & 0x04)) //Phase0/1 no touch, Phase2 touch
    {
        gravity = 4;
    }
    else
    {
        gravity = 2;
    }
#else
    if ((proximity_state & 0x20) && (!(proximity_state & 0x40)) && (!(proximity_state & 0x80)))      //Phase5 touch, Phase6/7 no touch
    {
        gravity = 0;
    }
    else if ((proximity_state & 0x20) && (proximity_state & 0x40) && (!(proximity_state & 0x80)))    //Phase5/6 touch, Phase7 no touch
    {
        gravity = 1;
    }
    else if ((!(proximity_state & 0x20)) && (proximity_state & 0x40) && (proximity_state & 0x80))    //Phase5 no touch, Phase6/7 touch
    {
        gravity = 3;
    }
    else if (!((proximity_state & 0x20)) && (!(proximity_state & 0x40)) && (proximity_state & 0x80)) //Phase5/6 no touch, Phase7 touch
    {
        gravity = 4;
    }
    else
    {
        gravity = 2;
    }
#endif

    return gravity;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_gesture_gravity_updata(tws_chip_index_e chipIndex, const TWS_U8 proximity_state)
{
    TWS_S8 gravity = 0;

    if ((g_gesture_var[chipIndex].status_cur == PUSH) && (g_gesture_var[chipIndex].status_last == RELEASE))//first touch, init gravity
    {
        gravity = cvt213x_gesture_gravity_cal(chipIndex, proximity_state);
        g_gesture_var[chipIndex].gravity_max = gravity;
        g_gesture_var[chipIndex].gravity_min = gravity;
    }
    else
    {
        if ((g_gesture_var[chipIndex].push_count != 0) && (g_gesture_var[chipIndex].push_count < g_gesture_cfg[chipIndex].long_push_thr))//touch before long-press detected
        {
            if (g_gesture_var[chipIndex].slide_repeat_cnt == 0)
            {
                gravity = cvt213x_gesture_gravity_cal(chipIndex, proximity_state);

                if (gravity > g_gesture_var[chipIndex].gravity_max)
                {
                    g_gesture_var[chipIndex].gravity_max = gravity;
                    g_gesture_var[chipIndex].slide_dir = TRUE;
                }

                if (gravity < g_gesture_var[chipIndex].gravity_min)
                {
                    g_gesture_var[chipIndex].gravity_min = gravity;
                    g_gesture_var[chipIndex].slide_dir = FALSE;
                }
            }
        }
    }

    CVT213X_LIB_LOG_D(3, "[gesture][gravity] cur:%d, max:%d, min:%d", gravity, g_gesture_var[chipIndex].gravity_max, g_gesture_var[chipIndex].gravity_min);
}
#endif

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_gesture_detect(tws_chip_index_e chipIndex)
{
    g_gesture_var[chipIndex].touch_event = TWS_EVENT_NONE;//clear touch event

    if (g_gesture_var[chipIndex].status_cur == PUSH)//keep touch
    {
        g_gesture_var[chipIndex].push_count++;

        CVT213X_LIB_LOG_W(1, "g_gesture_var[chipIndex].push_count =%d ",g_gesture_var[chipIndex].push_count);
        if(g_gesture_var[chipIndex].push_count == g_gesture_cfg[chipIndex].push_thr)
        {
            app_cvt213x_tone_down();
            cvt213x_tone_flag =1;
        }

        if (g_gesture_var[chipIndex].push_count < g_gesture_cfg[chipIndex].long_push_thr)//touch before long-press detected
        {
#if IS_TK_SLIDE_ENABLE
            if (g_gesture_var[chipIndex].slide_repeat_cnt == 0)//touch before slide detected
            {
                if ((g_gesture_var[chipIndex].gravity_max - g_gesture_var[chipIndex].gravity_min) >= g_slide_thr[chipIndex])//slide detected
                {
                    if (g_gesture_var[chipIndex].slide_dir)
                    {
                        g_gesture_var[chipIndex].touch_event = TWS_EVENT_SLIDE_UP;
                        g_gesture_var[chipIndex].last_slide_event = TWS_EVENT_SLIDE_UP;
                    }
                    else
                    {
                        g_gesture_var[chipIndex].touch_event = TWS_EVENT_SLIDE_DOWN;
                        g_gesture_var[chipIndex].last_slide_event = TWS_EVENT_SLIDE_DOWN;
                    }
                    CVT213X_LIB_LOG_W(1, "[gesture]set last_slide_event");
                    g_gesture_var[chipIndex].click_num = 0;
                    g_gesture_var[chipIndex].slide_repeat_cnt++;
                    CVT213X_LIB_LOG_W(1, "[gesture]slide detected %d", g_gesture_var[chipIndex].touch_event);
                }
            }
            else//touch after slide detected
            {
                if (g_gesture_cfg[chipIndex].slide_repeat_en)//keep report slide event
                {
                    if (g_gesture_var[chipIndex].slide_repeat_cnt >= g_gesture_cfg[chipIndex].slide_repeat_thr)//reach repeat report period
                    {
                        if (g_gesture_var[chipIndex].slide_dir)
                        {
                            g_gesture_var[chipIndex].touch_event = TWS_EVENT_SLIDE_UP;
                        }
                        else
                        {
                            g_gesture_var[chipIndex].touch_event = TWS_EVENT_SLIDE_DOWN;
                        }

                        g_gesture_var[chipIndex].slide_repeat_cnt = 0;
                    }

                    g_gesture_var[chipIndex].slide_repeat_cnt++;
                }
            }
#endif
        }
        else//touch after long-press detected
        {
            if (g_gesture_var[chipIndex].slide_repeat_cnt == 0) //no slide event detected
            {
                if ((g_gesture_var[chipIndex].click_num > 0) && ((g_gesture_cfg[chipIndex].click_and_long_press_en >> (g_gesture_var[chipIndex].click_num - 1)) & 0x01))
                {
                    if (g_gesture_var[chipIndex].push_count == g_gesture_cfg[chipIndex].click_and_long_press_thr)
                    {
                        g_gesture_var[chipIndex].touch_event = (tws_event_e)(TWS_EVENT_SINGLE_CLICK_AND_LONG_PRESS + (g_gesture_var[chipIndex].click_num - 1));
                        CVT213X_LIB_LOG_W(1, "[gesture] click-and-long-press detected 1  %d", g_gesture_var[chipIndex].touch_event);
                    }
                }
                else if ((g_gesture_var[chipIndex].last_slide_event != TWS_EVENT_NONE) && (g_gesture_cfg[chipIndex].click_and_long_press_en & 0x01))//single click and long press enable
                {
                    if (g_gesture_var[chipIndex].push_count == g_gesture_cfg[chipIndex].click_and_long_press_thr)
                    {
                        g_gesture_var[chipIndex].touch_event = (tws_event_e)(TWS_EVENT_SINGLE_CLICK_AND_LONG_PRESS);
                        CVT213X_LIB_LOG_W(1, "[gesture] click-and-long-press detected 2 %d", g_gesture_var[chipIndex].touch_event);
                    }
                }
                else
                {
                    if (g_gesture_var[chipIndex].push_count == g_gesture_cfg[chipIndex].long_push_thr)
                    {
                        g_gesture_var[chipIndex].touch_event = TWS_EVENT_LONG_PRESS;
                        CVT213X_LIB_LOG_W(1, "[gesture]long-press detected %d", g_gesture_var[chipIndex].touch_event);
                        g_gesture_var[chipIndex].click_num = 0;//clear click counter
                    }
                    else if (g_gesture_var[chipIndex].push_count == LONGLONG_PRESS_THRE)
                    {
                        g_gesture_var[chipIndex].touch_event = TWS_EVENT_LONGLONG_PRESS;
                        CVT213X_LIB_LOG_W(1, "[gesture]longlong-press detected %d", g_gesture_var[chipIndex].touch_event);
                        g_gesture_var[chipIndex].click_num = 0;//clear click counter
                    }
                    else
                    {
                        if (g_gesture_cfg[chipIndex].long_push_repeat_en)//keep report long-press event
                        {
                            if (g_gesture_var[chipIndex].push_count >= (TWS_U32)(g_gesture_cfg[chipIndex].long_push_thr + g_gesture_cfg[chipIndex].long_push_repeat_thr))//reach repeat report period
                            {
                                if (g_gesture_var[chipIndex].click_num == 0)
                                {
                                    g_gesture_var[chipIndex].touch_event = TWS_EVENT_LONG_PRESS;
                                    g_gesture_var[chipIndex].push_count = g_gesture_cfg[chipIndex].long_push_thr;
                                }
                            }
                        }
                    }
                }
            }
            else if (g_gesture_var[chipIndex].slide_repeat_cnt == 1)//slide event detected
            {
                if (g_gesture_var[chipIndex].push_count == g_gesture_cfg[chipIndex].long_push_thr)
                {
                    g_gesture_var[chipIndex].touch_event = TWS_EVENT_LONG_PRESS;
                    CVT213X_LIB_LOG_W(1, "[gesture]long-press detected base on slide event %d", g_gesture_var[chipIndex].touch_event);
                    g_gesture_var[chipIndex].click_num = 0;//clear click counter
                }
                else if (g_gesture_var[chipIndex].push_count == LONGLONG_PRESS_THRE)
                {
                    g_gesture_var[chipIndex].touch_event = TWS_EVENT_LONGLONG_PRESS;
                    CVT213X_LIB_LOG_W(1, "[gesture]longlong-press detected base on slide event %d", g_gesture_var[chipIndex].touch_event);
                    g_gesture_var[chipIndex].click_num = 0;//clear click counter
                }
            }

            //  if (g_gesture_var[chipIndex].push_count == g_fix_compensation_thr[chipIndex])
            // {
            //     g_gesture_var[chipIndex].touch_event = TWS_EVENT_FIX_COMPENSATION; 
            //     CVT213X_LIB_LOG_W(1, "[gesture]fix compensation detected %d", g_gesture_var[chipIndex].touch_event);
            //     }
            // }
        }
    }
    else if (g_gesture_var[chipIndex].status_cur == RELEASE)//no-touch
    {
        if (g_gesture_var[chipIndex].status_last == PUSH)//first no-touch
        {
            g_gesture_var[chipIndex].release_count = 0;
        }

        if (g_gesture_var[chipIndex].release_count == g_gesture_cfg[chipIndex].click_thr)//reach gap cycle
        {
            if (g_gesture_var[chipIndex].click_num > 0)//N-click event detected
            {
                if (g_gesture_var[chipIndex].click_num > g_gesture_click_thr[chipIndex])
                {
                    #if CLICK_SUPPRESSION
                        g_gesture_var[chipIndex].click_num = 0;
                    #else
                        g_gesture_var[chipIndex].click_num = g_gesture_click_thr[chipIndex];
                    #endif
                }
                if ((g_gesture_var[chipIndex].click_num > 0) && ((g_gesture_cfg[chipIndex].click_num_en >> (g_gesture_var[chipIndex].click_num - 1)) & 0x01))
                {
                    g_gesture_var[chipIndex].touch_event = (tws_event_e)(g_gesture_var[chipIndex].click_num);
                }
                else
                {
                    g_gesture_var[chipIndex].touch_event = TWS_EVENT_NONE;
                }

                g_gesture_var[chipIndex].click_num = 0;
                CVT213X_LIB_LOG_W(1, "[gesture]click detected %d", g_gesture_var[chipIndex].touch_event);
            }

            g_gesture_var[chipIndex].last_slide_event = TWS_EVENT_NONE;
            CVT213X_LIB_LOG_W(1, "[gesture]clear last_slide_event");
        }
        else
        {
            if (g_gesture_var[chipIndex].release_count == g_gesture_cfg[chipIndex].release_thr)//release debounce
            {
                if(cvt213x_tone_flag ==1)
                {
                    app_cvt213x_tone_up();
                    cvt213x_tone_flag =0;
                }
                if (g_gesture_var[chipIndex].slide_repeat_cnt)
                {
                    g_gesture_var[chipIndex].slide_repeat_cnt = 0;//clear slide
                }
                else
                {
                    if (g_gesture_var[chipIndex].push_count >= g_gesture_cfg[chipIndex].push_thr)
                    {
                        CVT213X_LIB_LOG_W(1, "[gesture]push_count %d", g_gesture_var[chipIndex].push_count);

                        if ((g_gesture_cfg[chipIndex].click_and_long_press_en >> (g_gesture_var[chipIndex].click_num - 1)) & 0x01)
                        {
                            if (g_gesture_var[chipIndex].push_count < g_gesture_cfg[chipIndex].click_and_long_press_thr)
                            {
                                g_gesture_var[chipIndex].click_num++;
                            }
                            else
                            {
                                g_gesture_var[chipIndex].click_num = 0;
                            }
                        }
                        else
                        {
                            if (g_gesture_var[chipIndex].push_count < g_gesture_cfg[chipIndex].long_push_thr)
                            {
                                g_gesture_var[chipIndex].click_num++;
                            }
                        }
                    }
                }

                if((g_gesture_var[chipIndex].push_count > LONG_PRESS_THRE)&&(g_gesture_var[chipIndex].push_count < LONGLONG_PRESS_THRE)){
                    g_gesture_var[chipIndex].touch_event =  TWS_EVENT_LONG_PRESS_UP;
                    g_gesture_var[chipIndex].click_num = 0;//clear click counter
                }
                g_gesture_var[chipIndex].push_count = 0;
            }

            g_gesture_var[chipIndex].release_count++;
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
static tws_event_e cvt213x_gesture_algo(tws_chip_index_e chipIndex, const TWS_U8 proximity_state)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_gesture_algo() enter");

    CVT213X_LIB_LOG_W(0, "[gesture] proximity_state: 0x%02x", proximity_state);

#if IS_TK_SLIDE_ENABLE
    #if (CVT213X_IC_TYPE_SELECT != IC_TYPE_CVT2138)
        if (proximity_state & (TWS_STAT_PH0 | TWS_STAT_PH1 | TWS_STAT_PH2))
    #else
        if (proximity_state & (TWS_STAT_PH5 | TWS_STAT_PH6 | TWS_STAT_PH7))
    #endif
#elif IS_TK_TOUCH_ENABLE
    if (proximity_state & TWS_STAT_PH0)
#endif
    {
        g_gesture_var[chipIndex].status_cur = PUSH;
        CVT213X_LIB_LOG_D(0, "[gesture][push]");
    }
    else
    {
        g_gesture_var[chipIndex].status_cur = RELEASE;
        CVT213X_LIB_LOG_D(0, "[gesture][release]");
    }

#if IS_TK_SLIDE_ENABLE
    cvt213x_gesture_gravity_updata(chipIndex, proximity_state);
#endif

    cvt213x_gesture_detect(chipIndex);

    g_gesture_var[chipIndex].status_last = g_gesture_var[chipIndex].status_cur;

    return (tws_event_e)g_gesture_var[chipIndex].touch_event;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static TWS_U8 cvt213x_gesture_is_idle(tws_chip_index_e chipIndex)
{
    if ((g_gesture_var[chipIndex].push_count == 0) && (g_gesture_var[chipIndex].click_num == 0) && (g_gesture_var[chipIndex].last_slide_event == TWS_EVENT_NONE)) //recover to doze mode
    {
        return 1;
    }

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
static void cvt213x_gesture_handle_default(tws_chip_index_e chipIndex, TWS_U8 *rd_irq)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_gesture_handle_default() enter");

    if (rd_irq[0] & TWS_IRQ_COMPDONE) //compensation done
    {
        #if (CVT213X_IC_TYPE_SELECT != IC_TYPE_CVT2138)
            TWS_S32 rd_cc_data[5] = {0};
        #else
            TWS_S32 rd_cc_data[8] = {0};
        #endif

        cvt213x_i2c_read_comp_data(chipIndex, rd_cc_data);
        CVT213X_LIB_LOG_E(1, "Chip%d, Calibration OK ! ! ! !",chipIndex);

        cvt213x_scan_mode_switch(chipIndex, DEFAULT_MODE, INIT_MODE);
#if CVT213X_SETUP_FUN
        {
            TWS_U8 rd_data[4] = {0};
            cvt213x_util_i2c_read(chipIndex, 0x3134, rd_data, 4);
            g_phx_ref_use_0c[0] = (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
            cvt213x_util_i2c_read(chipIndex, 0x3234, rd_data, 4);
            g_phx_ref_use_0c[1] = (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
            CVT213X_LIB_LOG_E(1, "ref_use_0c: ph1=%d ph2=%d", cvt213x_transfer_reg_to_data(g_phx_ref_use_0c[0]), cvt213x_transfer_reg_to_data(g_phx_ref_use_0c[1]));
        }
#endif
    }
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_gesture_handle_init(tws_chip_index_e chipIndex, TWS_U8 *rd_irq)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_gesture_handle_init() enter");

    if (g_timeout[chipIndex] >= TIMEOUT_CYCLE) //discard 1 frame rawdata
    {
        if (rd_irq[0] & TWS_IRQ_READY) //idle done
        {
            if (cvt213x_get_next_scan_mode(chipIndex) == DOZE_MODE)
            {
                cvt213x_scan_mode_switch(chipIndex, INIT_MODE, DOZE_MODE);

                g_timeout[chipIndex] = 0;
            }
        }
        else if (rd_irq[0] & TWS_IRQ_CONVDONE)//sampling done
        {
            cvt213x_scan_mode_prepare_switch(chipIndex, DOZE_MODE);
        }
    }
    else
    {
        if (rd_irq[0] & TWS_IRQ_CONVDONE)
        {
            g_timeout[chipIndex]++;
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
static tws_event_e cvt213x_gesture_handle_doze(tws_chip_index_e chipIndex, TWS_U8 *rd_irq, TWS_U8 *proximity_state)
{
    CVT213X_UNUSED(chipIndex);
    CVT213X_UNUSED(proximity_state);
    CVT213X_LIB_LOG_D(0, "cvt213x_gesture_handle_doze() enter");

    if (rd_irq[0] & TWS_IRQ_READY) // idle done
    {
        CVT213X_LIB_LOG_E(0, "Doze mode abnormal reset may happened");
    }
#if IS_TK_ENABLE
    else if (rd_irq[0] & TWS_IRQ_CLOSE) //close event, it means touch happened
    {
        #if (CVT213X_IC_TYPE_SELECT != IC_TYPE_CVT2138)
            if (((g_chip_func[chipIndex] & FUNC_TOUCH_ENABLE) && (proximity_state[0] & TWS_STAT_PH0))
                || ((g_chip_func[chipIndex] & FUNC_SLIDE_ENABLE) && (proximity_state[0] & (TWS_STAT_PH0 | TWS_STAT_PH1 | TWS_STAT_PH2))))
        #else
            if (((g_chip_func[chipIndex] & FUNC_TOUCH_ENABLE) && (proximity_state[0] & TWS_STAT_PH0))
                || ((g_chip_func[chipIndex] & FUNC_SLIDE_ENABLE) && (proximity_state[0] & (TWS_STAT_PH5| TWS_STAT_PH6 | TWS_STAT_PH7))))
        #endif
        {
            cvt213x_gesture_var_init(chipIndex);

            cvt213x_gesture_algo(chipIndex, proximity_state[0]);

            cvt213x_scan_mode_switch(chipIndex, DOZE_MODE, ACTIVE_MODE);
        }
    }
#endif

    return TWS_EVENT_NONE;
}

#if IS_TK_ENABLE
/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static tws_event_e cvt213x_gesture_handle_active(tws_chip_index_e chipIndex, TWS_U8 *rd_irq, TWS_U8 *proximity_state)
{
    CVT213X_LIB_LOG_D(0, "cvt213x_gesture_handle_active() enter");

    if (rd_irq[0] & TWS_IRQ_READY) //idle done
    {
        CVT213X_LIB_LOG_E(0, "Active mode abnormal reset may happened");
    }
    else
    {
        tws_event_e event = TWS_EVENT_NONE;

        event |= cvt213x_gesture_algo(chipIndex, proximity_state[0]);

        if (cvt213x_gesture_is_idle(chipIndex)) //recover to doze mode
        {
            cvt213x_gesture_var_init(chipIndex);

            cvt213x_scan_mode_switch(chipIndex, ACTIVE_MODE, DOZE_MODE);
        }

        CVT213X_LIB_LOG_W(0, "cvt213x_gesture_handle_active event =%d",event);

        return event;
    }

    return TWS_EVENT_NONE;
}
#endif

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
tws_event_e cvt213x_gesture_process(tws_chip_index_e chipIndex)
{
    TWS_U8 rd_irq[2] = {0};
    tws_event_e tws_touch_event = TWS_EVENT_NONE;
    TWS_U8 proximity_state[1] = {0};
    static TWS_U8 s_proximity_state_last[TWS_CHIP_NUM] =
    {
        0x00,
    #if DUAL_CVT213X_ENABLE
        0x00,
    #endif
    };

    CVT213X_LIB_LOG_D(0, "cvt213x_gesture_process() enter");

    if (cvt213x_util_get_init_flag(chipIndex) != INIT_DONE)
    {
        return TWS_EVENT_NONE;
    }

    if (cvt213x_get_next_scan_mode(chipIndex) == HOST_SLEEP_MODE)
    {
        return TWS_EVENT_NONE;
    }

    if (!app_cvt231x_irq_get_leavel(chipIndex))
    {
        cvt213x_i2c_read_irq(chipIndex, rd_irq);
        cvt213x_i2c_clear_int(chipIndex);
        cvt213x_i2c_read_touch_state(chipIndex, proximity_state);
        s_proximity_state_last[chipIndex] = proximity_state[0];
    }
    else
    {
        proximity_state[0] = s_proximity_state_last[chipIndex];
    }

    CVT213X_LIB_LOG_D(4, "chip%d, scan mode:%d, irq[0]:0x%02x, iqr[1]:0x%02x", chipIndex, cvt213x_get_scan_mode(chipIndex), rd_irq[0], rd_irq[1]);
    switch (cvt213x_get_scan_mode(chipIndex))
    {
    case DEFAULT_MODE:
    {
        cvt213x_gesture_handle_default(chipIndex, rd_irq);
        break;
    }
    case INIT_MODE:
    {
        cvt213x_gesture_handle_init(chipIndex, rd_irq);
        break;
    }
    case DOZE_MODE:
    {
        tws_touch_event = cvt213x_gesture_handle_doze(chipIndex, rd_irq, proximity_state);
        break;
    }
#if IS_TK_ENABLE
    case ACTIVE_MODE:
    {
        tws_touch_event = cvt213x_gesture_handle_active(chipIndex, rd_irq, proximity_state);
        break;
    }
#endif
    case NULL_MODE:
        break;

    default:
        break;
    }

    return tws_touch_event;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
tws_event_e cvt213x_ied_process(tws_chip_index_e chipIndex)
{
    tws_event_e event = TWS_EVENT_NONE;

    CVT213X_LIB_LOG_D(0, "cvt213x_ied_process() enter");
#if IS_IED_ENABLE
    TWS_U8 proximity_state[1] = {0};
    cvt213x_i2c_read_touch_state(chipIndex, proximity_state);
    // CVT213X_LIB_LOG_E(0, "proximity_state:0x%02x",proximity_state[0]);

#if CVT213X_SETUP_FUN
    if (g_last_prox_state)
    {
        TWS_U8 state = cvt213x_setup_get_state(chipIndex, g_setup_ph);
        TWS_U8 state2 = proximity_state[0];
        state2 &= ~g_setup_ph;
        state2 |= state;
        // CVT213X_LIB_LOG_D(0, "state:0x%02x state2:0x%02x", state, state2);

        if (((g_chip_func[chipIndex] & FUNC_DOU_IED) && ((state2 & g_last_prox_state) == g_last_prox_state))
            || ((g_chip_func[chipIndex] & FUNC_SIG_IED) && ((state2 & g_last_prox_state) == TWS_STAT_PH4)))
        {
            g_cvt213x_on_cnt++;
            g_cvt213x_off_cnt = 0;

            g_cvt213x_ph3_off_cnt = 0;
            if(g_cvt213x_ph3_inear_state_cnt < IED_PH3_INEAR_DROP_DEBOUNCE_NUM)g_cvt213x_ph3_inear_state_cnt++;

            if(g_cvt213x_on_cnt == IED_ON_DEBOUNCE_NUM)
            {
                if (!isInEar[chipIndex])
                {
                    CVT213X_LIB_LOG_E(0, "ied detect by setup on!");
                    event |= TWS_EVENT_IED_ON;
                    isInEar[chipIndex] = TRUE;
                }
                if(g_cvt213x_outbox_flag)
                {
                    if(isInEar[chipIndex])
                    {
                        CVT213X_LIB_LOG_E(0,"setup TWS_EVENT_IED_ON resend");
                        event |= TWS_EVENT_IED_ON;
                        isInEar[chipIndex] = TRUE;
                    }
                    g_cvt213x_outbox_flag = FALSE;
                }
                g_cvt213x_on_cnt = 0;
            }
        }
        else if (((g_chip_func[chipIndex] & FUNC_DOU_IED) && ((state2 & g_last_prox_state) == 0x00))
            ||((g_chip_func[chipIndex] & FUNC_SIG_IED) && (state2 & TWS_STAT_PH4) == 0x00))
        {
            g_cvt213x_off_cnt++;
            g_cvt213x_on_cnt = 0;

            g_cvt213x_ph3_off_cnt = 0;
            g_cvt213x_ph3_inear_state_cnt = 0;

            if(g_cvt213x_off_cnt == IED_OFF_DEBOUNCE_NUM)
            {
                if (isInEar[chipIndex])
                {
                    CVT213X_LIB_LOG_E(0, "ied detect by setup off!");
                    event |= TWS_EVENT_IED_OFF;
                    isInEar[chipIndex] = FALSE;
                }
                g_cvt213x_off_cnt = 0;
            }

            #if CVT213X_DROP_STEP_FUN
            if(g_chip_func[chipIndex] & FUNC_DOU_IED)
            {
                cvt213x_ied_drop_clear_info();
            }
            #endif
        }
        // else if((g_chip_func[chipIndex] & FUNC_DOU_IED) && ((state2 & g_last_prox_state) == 0x08)) //earphone on desktop ,less than thr , force out ear
        // {
        //     if (isInEar[chipIndex])
        //     {
        //         if(g_ied_flt[0].diff <= IED_DESKTOP_DIFF_THR)
        //             g_cvt213x_ph3_off_cnt++;
        //         else
        //             g_cvt213x_ph3_off_cnt = 0;

        //         if(g_cvt213x_ph3_off_cnt == 8)
        //         {
        //             event |= TWS_EVENT_IED_OFF;
        //             isInEar[chipIndex] = FALSE;
        //             g_cvt213x_ph3_off_cnt = 0;
        //             CVT213X_LIB_LOG_E(0, "setup , desktop ear out");
        //         }
        //     }
        // }
#if CVT213X_DROP_STEP_FUN
        else if((g_chip_func[chipIndex] & FUNC_DOU_IED) && ((state2 & g_last_prox_state) == 0x10))
        {
            if((g_cvt213x_ph3_inear_state_cnt >= IED_PH3_INEAR_DROP_DEBOUNCE_NUM))
            {
                if((g_ied_drop_flag[0] ==1) || (g_ied_drop_flag[1] ==1))
                {
                    if (isInEar[chipIndex])
                    {
                        CVT213X_LIB_LOG_E(0, "setup drop ph3 large step ,force out ear!!!");
                        event |= TWS_EVENT_IED_OFF;
                        isInEar[chipIndex] = FALSE;
                        CVT213X_LIB_LOG_E(0, "g_cvt213x_ph3_inear_state_cnt =%d",g_cvt213x_ph3_inear_state_cnt);
                    }
                }
            }
            if((g_cvt213x_ph3_inear_state_cnt == 0) && ((g_ied_drop_flag[1] ==1)))   //PH3不大于阈值，PH4 满足条件强制掉落
            {
                if (isInEar[chipIndex])
                {
                    CVT213X_LIB_LOG_E(0, "setup drop ph4 large step ,force out ear!!!");
                    event |= TWS_EVENT_IED_OFF;
                    isInEar[chipIndex] = FALSE;
                    CVT213X_LIB_LOG_E(0, "g_cvt213x_ph3_inear_state_cnt =%d",g_cvt213x_ph3_inear_state_cnt);
                }
            }
            cvt213x_ied_drop_clear_info();
            g_cvt213x_ph3_inear_state_cnt = 0;
        }
        else if((g_chip_func[chipIndex] & FUNC_DOU_IED) && ((state2 & g_last_prox_state) == 0x08))
        {
            if((g_ied_drop_flag[0] ==1) || (g_ied_drop_flag[1] ==1))
            {
                if (isInEar[chipIndex])
                {
                    CVT213X_LIB_LOG_E(0, "setup drop ph4 large step ,force out ear!!!");
                    event |= TWS_EVENT_IED_OFF;
                    isInEar[chipIndex] = FALSE;
                }
            }
            cvt213x_ied_drop_clear_info();
        }
#endif
        return event;
    }
#endif

#if CVT213X_DROP_STEP_FUN
    if(g_chip_func[chipIndex] & FUNC_DOU_IED)
    {
        TWS_S32 temp_data[2] ={0};
        cvt213x_ied_drop_step_calc(chipIndex,proximity_state,temp_data);
    }
#endif
    if (((g_chip_func[chipIndex] & FUNC_DOU_IED) && ((proximity_state[0] & TWS_STAT_PH4) && (proximity_state[0] & TWS_STAT_PH3)))
        ||((g_chip_func[chipIndex] & FUNC_SIG_IED) && (proximity_state[0] & TWS_STAT_PH4)))
    {
        g_cvt213x_off_cnt = 0;

        g_cvt213x_ph3_off_cnt = 0;
        if(g_cvt213x_ph3_inear_state_cnt < IED_PH3_INEAR_DROP_DEBOUNCE_NUM) 
            g_cvt213x_ph3_inear_state_cnt++;

        if (!isInEar[chipIndex])
        {
            g_cvt213x_on_cnt++;
            if(g_cvt213x_on_cnt == IED_ON_DEBOUNCE_NUM)
            {
                event |= TWS_EVENT_IED_ON;
                isInEar[chipIndex] = TRUE;
                g_cvt213x_on_cnt = 0;
            }
        }
        if(g_cvt213x_outbox_flag)
        {
            if(isInEar[chipIndex])
            {
                CVT213X_LIB_LOG_E(0,"normal TWS_EVENT_IED_ON resend");
                event |= TWS_EVENT_IED_ON;
                isInEar[chipIndex] = TRUE;
            }
            g_cvt213x_outbox_flag = FALSE;
        }

    }
    else if (((g_chip_func[chipIndex] & FUNC_DOU_IED) && (!(proximity_state[0] & (TWS_STAT_PH4 | TWS_STAT_PH3))))
        || ((g_chip_func[chipIndex] & FUNC_SIG_IED) && (!(proximity_state[0] & TWS_STAT_PH4))))
    {
        g_cvt213x_on_cnt = 0;

        g_cvt213x_ph3_off_cnt = 0;
        g_cvt213x_ph3_inear_state_cnt = 0;

        if (isInEar[chipIndex])
        {
            g_cvt213x_off_cnt++;
            if(g_cvt213x_off_cnt == IED_OFF_DEBOUNCE_NUM)
            {
                event |= TWS_EVENT_IED_OFF;
                isInEar[chipIndex] = FALSE;
                g_cvt213x_off_cnt = 0;
            }
        }

        #if CVT213X_DROP_STEP_FUN
        if(g_chip_func[chipIndex] & FUNC_DOU_IED)
        {
            cvt213x_ied_drop_clear_info();
        }
        #endif
    }
    // else if((g_chip_func[chipIndex] & FUNC_DOU_IED) && (proximity_state[0] & TWS_STAT_PH3))
    // {
    //     TWS_S32 ph_diff[1] ={0};
    //     if(isInEar[chipIndex])
    //     {
    //         app_cvt213x_inear_debounce_restart();

    //         //read ph3 diff ,ph3 close desktop
    //         cvt213x_get_phase_diff_data(chipIndex, 3, ph_diff);
    //         if(ph_diff[0] <= IED_DESKTOP_DIFF_THR)
    //             g_cvt213x_ph3_off_cnt++;
    //         else
    //             g_cvt213x_ph3_off_cnt = 0;

    //         if(g_cvt213x_ph3_off_cnt == 8)
    //         {
    //             event |= TWS_EVENT_IED_OFF;
    //             isInEar[chipIndex] = FALSE;
    //             g_cvt213x_ph3_off_cnt = 0;
    //             CVT213X_LIB_LOG_E(0, "normal , desktop ear out");

    //             app_cvt213x_inear_debounce_stop();
    //         }
    //     }
    // }
#if CVT213X_DROP_STEP_FUN
    else if((g_chip_func[chipIndex] & FUNC_DOU_IED) && ((proximity_state[0] & 0x18) == TWS_STAT_PH4))
    {
        if((g_cvt213x_ph3_inear_state_cnt >= IED_PH3_INEAR_DROP_DEBOUNCE_NUM))
        {
            if((g_ied_drop_flag[0] ==1) || (g_ied_drop_flag[1] ==1))
            {
                if (isInEar[chipIndex])
                {
                    CVT213X_LIB_LOG_E(0, "normal drop ph3 large step ,force out ear!!!");
                    event |= TWS_EVENT_IED_OFF;
                    isInEar[chipIndex] = FALSE;
                    CVT213X_LIB_LOG_E(0, "g_cvt213x_ph3_inear_state_cnt =%d",g_cvt213x_ph3_inear_state_cnt);
                }
            }
        }
        if((g_cvt213x_ph3_inear_state_cnt == 0) && ((g_ied_drop_flag[1] ==1)))   //PH3不大于阈值，PH4 满足条件强制掉落
        {
                if (isInEar[chipIndex])
            {
                CVT213X_LIB_LOG_E(0, "normal drop ph4 large step ,force out ear!!!");
                event |= TWS_EVENT_IED_OFF;
                    isInEar[chipIndex] = FALSE;
                CVT213X_LIB_LOG_E(0, "g_cvt213x_ph3_inear_state_cnt =%d",g_cvt213x_ph3_inear_state_cnt);
            }
        }
        cvt213x_ied_drop_clear_info();
        g_cvt213x_ph3_inear_state_cnt = 0;
    }
    else if((g_chip_func[chipIndex] & FUNC_DOU_IED) && ((proximity_state[0] & 0x18) == TWS_STAT_PH3))
    {
        if((g_ied_drop_flag[0] ==1) || (g_ied_drop_flag[1] ==1))
        {
            if (isInEar[chipIndex])
            {
                CVT213X_LIB_LOG_E(0, "normal drop ph4 large step ,force out ear!!!");
                event |= TWS_EVENT_IED_OFF;
                isInEar[chipIndex] = FALSE;
            }
        }
        cvt213x_ied_drop_clear_info();
    }
#endif
#endif
    return event;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_ied_set_last_prox_state(TWS_U8 state)
{
    g_last_prox_state = state;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_U8 cvt213x_ied_get_last_prox_state(void)
{
    return g_last_prox_state;
}

#if IS_IED_ENABLE
/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_ied_var_init(tws_chip_index_e chipIndex)
{
    isInEar[chipIndex] = FALSE;
#if CVT213X_DROP_STEP_FUN
    g_ied_getraw_cnt =0;
#endif
#if CVT213X_SETUP_FUN
    g_ied_flt_cnt = 0;
    g_ied_flt[0].isInEar = 0;
    g_ied_flt[0].dropCnt = 0;
    g_ied_flt[1].isInEar = 0;
    g_ied_flt[1].dropCnt = 0;
#endif
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_S32 cvt213x_ied_raw_median_filter(TWS_S32 a, TWS_S32 b, TWS_S32 c)
{
    TWS_U8 i,j;
    TWS_S32 filter;
    TWS_S32 temp[3] = {a, b, c};

    for (j = 0; j < 2; j++)
    {
        for (i = 0; i < (2 - j); i++)
        {
            if (temp[i] > temp[i + 1])
            {
                filter = temp[i];
                temp[i] = temp[i + 1];
                temp[i + 1] = filter;
            }
        }
    }

    return temp[1];
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_S32 cvt213x_ied_base_iir_filter(TWS_S32 raw, TWS_S32 base, TWS_U8 pos_coef, TWS_U8 neg_coef)
{
    TWS_S32 filter = 0;
    TWS_U8  coef = 0;

    if (raw > base)
    {
        coef = pos_coef;
    }
    else
    {
        coef = neg_coef;
    }

    filter = ((128 - coef) * base + coef * raw) / 128;

    return filter;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_S32 cvt213x_ied_get_data(tws_chip_index_e chipIndex, TWS_U32 addr)
{
    TWS_U8 rd_data[4] = {0};
    TWS_S32 temp = 0;

    cvt213x_util_i2c_read(chipIndex, addr, rd_data, 4);

    temp  = (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);

    if (rd_data[2] & 0x10)
    {
        temp -= 0x00200000;
    }

    return temp;
}

#if CVT213X_DROP_STEP_FUN
/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_ied_drop_clear_info(void)
{
    g_ied_drop_flag[0] = 0;
    g_ied_drop_flag[1] = 0;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_ied_drop_get_raw(tws_chip_index_e chipIndex,TWS_S32 *rd_raw)
{
    TWS_U8 index = 0,ph=0;
    for (index = 3; index < 5; index++)
    {
        ph = index - 3;
        rd_raw[ph] = cvt213x_ied_get_data(chipIndex, 0x3030 + 0x100 * index);
        if (g_ied_getraw_cnt == 0)
        {
            g_ied_drop_raw_mid_buf[0] = rd_raw[ph];
            g_ied_drop_raw_mid_buf[1] = rd_raw[ph];
            g_ied_drop_raw_mid_buf[2] = rd_raw[ph];
        }
        cvt213x_util_buf_push(g_ied_drop_raw_mid_buf, rd_raw[ph], 3);
        rd_raw[ph] = cvt213x_ied_raw_median_filter(g_ied_drop_raw_mid_buf[0], g_ied_drop_raw_mid_buf[1], g_ied_drop_raw_mid_buf[2]);
    }
    if(g_ied_getraw_cnt ==0)g_ied_getraw_cnt = 1;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
static void cvt213x_ied_drop_step_calc(tws_chip_index_e chipIndex, TWS_U8 *ph_state, TWS_S32 *ph_rawdata)
{
    TWS_U8 ph_index =0;
    TWS_S32 sen_data[2] ={0};
    //get raw
    if(!g_last_prox_state)
        cvt213x_ied_drop_get_raw(chipIndex,sen_data);
    else
    {
        sen_data[0] = ph_rawdata[0];
        sen_data[1] = ph_rawdata[1];
    }

    //after inear,update phx start raw
    if(((!g_last_prox_state)&&(ph_state[0]&TWS_STAT_PH3))
#if CVT213X_SETUP_FUN
        ||(g_last_prox_state&&g_ied_flt[0].isInEar)
#endif
        )
    {
        if(((sen_data[0] - g_ied_last_raw[0]) >= -PH_SLOPE_SETP_RAW)&&(g_ied_stop_update_raw_flag[0] == 0))
        {
            g_ied_last_raw[0] =sen_data[0];
            g_ied_start_time[0] = cvt213x_util_get_current_timer();
            // CVT213X_LIB_LOG_D(1,"PH3,update inear raw =%d",sen_data[0]);
        }
        else
        {
            g_ied_stop_update_raw_flag[0] = 1;
        }
    }

    if(((!g_last_prox_state)&&(ph_state[0]&TWS_STAT_PH4))
#if CVT213X_SETUP_FUN
        ||(g_last_prox_state&&g_ied_flt[1].isInEar)
#endif
        )
    {
        if(((sen_data[1] - g_ied_last_raw[1]) >= -PH_SLOPE_SETP_RAW)&&(g_ied_stop_update_raw_flag[1] == 0))
        {
            g_ied_last_raw[1] =sen_data[1];
            g_ied_start_time[1] = cvt213x_util_get_current_timer();
            // CVT213X_LIB_LOG_D(1,"PH4,update inear raw =%d",sen_data[1]);
        }
        else
        {
            g_ied_stop_update_raw_flag[1] = 1;
        }
    }


    for(int index =3;index<5;index++)
    {
        ph_index = index-3;
        g_ied_current_timer[ph_index] = cvt213x_util_get_current_timer();
        // CVT213X_LIB_LOG_D(4,"PH%d,D-timer =%d,Drop-value =%d,g_ied_last_raw=%d",index,(g_ied_current_timer[ph_index]-g_ied_start_time[ph_index]),(g_ied_last_raw[ph_index] - sen_data[ph_index]),g_ied_last_raw[ph_index]);
        if((g_ied_current_timer[ph_index]- g_ied_start_time[ph_index]) < DROP_STEP_TIMER)
        {
            if(index == 3)
            {
                if((g_ied_last_raw[ph_index] - sen_data[ph_index]) > PH3_DROP_STEP_RAW)
                {
                    g_ied_drop_flag[ph_index] = 1;
                    CVT213X_LIB_LOG_D(2,"PH%d,drop large step !!!,Drop-value =%d",index,(g_ied_last_raw[ph_index] - sen_data[ph_index]));
                }
            }
            else
            {
                if((g_ied_last_raw[ph_index] - sen_data[ph_index]) > PH4_DROP_STEP_RAW)
                {
                    g_ied_drop_flag[ph_index] = 1;
                    CVT213X_LIB_LOG_D(2,"PH%d,drop large step !!!,Drop-value =%d",index,(g_ied_last_raw[ph_index] - sen_data[ph_index]));
                }
            }

        }
        else
        {
            g_ied_start_time[ph_index] = g_ied_current_timer[ph_index];
            g_ied_last_raw[ph_index] =sen_data[ph_index];
            g_ied_stop_update_raw_flag[ph_index] = 0;
        }
    }

}
#endif

#if CVT213X_SETUP_FUN
void cvt213x_setup_update_ph3_thr(TWS_U32 thr)
{
    g_phx_in_ear_thr[0] = thr;
    CVT213X_LIB_LOG_D(1, "update ph3_thr to %d", thr);
}

void cvt213x_setup_update_ph4_thr(TWS_U32 thr)
{
    g_phx_in_ear_thr[1] = thr;
    CVT213X_LIB_LOG_D(1, "update ph4_thr to %d", thr);
}

void cvt213x_is_earphone_in_box_state_set(TWS_U8 state)
{
    g_is_earphone_in_box_flag = state;
    CVT213X_LIB_LOG_D(1, "update in_box_state to %d", state);
}

TWS_U8 cvt213x_is_earphone_in_box_state_get(void)
{
    return g_is_earphone_in_box_flag;
}


TWS_S32 cvt213x_setup_algo_get_raw(tws_chip_index_e chipIndex, TWS_U8 ied_chan)
{
    CVT213X_UNUSED(chipIndex);
    return g_ied_flt[ied_chan].raw;
}

TWS_S32 cvt213x_setup_algo_get_base(tws_chip_index_e chipIndex, TWS_U8 ied_chan)
{
    CVT213X_UNUSED(chipIndex);
    return g_ied_flt[ied_chan].base;
}

TWS_S32 cvt213x_setup_algo_get_diff(tws_chip_index_e chipIndex, TWS_U8 ied_chan)
{
    CVT213X_UNUSED(chipIndex);
    return g_ied_flt[ied_chan].diff;
}
/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_setup_info_check_validation(TWS_U8 *cfg_buf, TWS_U16 len)
{
    TWS_U16 i = 0;
    TWS_U8 cfg_cksum = 0;

    CVT213X_LIB_LOG_D(0, "cvt213x_setup_info_check_validation() enter");

    //check header
    if ((cfg_buf[0] != SETUP_INFO_HEADER1)
        && (cfg_buf[1] != SETUP_INFO_HEADER2)
        && (cfg_buf[2] != SETUP_INFO_HEADER3)
        && (cfg_buf[3] != SETUP_INFO_HEADER4))
    {
        return FALSE;
    }

    //calculate checksum
    for (i = 0; i < len; i++)
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
static void cvt213x_setup_info_add_header_tail(TWS_U8 *cfg_buf, TWS_U16 len)
{
    TWS_U16 i = 0;
    TWS_U8 cfg_cksum = 0;

    CVT213X_LIB_LOG_D(0, "cvt213x_setup_info_add_header_tail() enter");

    //add header
    cfg_buf[0] = SETUP_INFO_HEADER1;
    cfg_buf[1] = SETUP_INFO_HEADER2;
    cfg_buf[2] = SETUP_INFO_HEADER3;
    cfg_buf[3] = SETUP_INFO_HEADER4;

    //add tail
    // cfg_buf[len - 3] = 0x00;
    cfg_buf[len - 2] = 0x00;

    //calculate checksum
    for (i = 0; i < len - 1; i++)
    {
        cfg_cksum ^= cfg_buf[i];
    }

    //add checksum
    cfg_buf[i] = cfg_cksum;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_get_setup_info_from_flash(void)
{
    TWS_U8 buff[SETUP_INFO_LEN] = {0};

    CVT213X_LIB_LOG_D(0, "cvt213x_get_setup_info_from_flash() enter");

    cvt213x_util_setup_flash_read(buff, SETUP_INFO_LEN);

    cvt213x_util_memcpy(&g_setup_info_var, buff, sizeof(g_setup_info_var));

    return TRUE;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
TWS_BOOL cvt213x_set_setup_info_to_flash(void)
{
    // g_setup_valid = 1; //TEST
    if (g_setup_valid)
    {
        TWS_U8 buff[SETUP_INFO_LEN] = {0};

        CVT213X_LIB_LOG_E(0, "cvt213x_set_setup_info_to_flash() enter");

        cvt213x_util_memcpy(buff, &g_setup_info_var, sizeof(g_setup_info_var));

        cvt213x_util_setup_flash_write(buff, SETUP_INFO_LEN);
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
void cvt213x_setup_info_clear(void)
{
    TWS_U8 buff[SETUP_INFO_LEN] = {0};

    CVT213X_LIB_LOG_D(0, "cvt213x_setup_info_clear() enter");

    cvt213x_util_setup_flash_write(buff, SETUP_INFO_LEN);
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_setup_detect(tws_chip_index_e chipIndex)
{
    CVT213X_LIB_LOG_E(0, "cvt213x_setup_detect() enter");

    cvt213x_get_setup_info_from_flash();

    if (cvt213x_setup_info_check_validation((TWS_U8 *)&g_setup_info_var, sizeof(g_setup_info_var)))
    {
        TWS_U8 index = 0;

        for (index = 3; index < 5; index++)
        {
            TWS_U16 setup_cca = g_setup_info_var.cca[index - 1];
            TWS_U16 setup_ccb = g_setup_info_var.ccb[index - 1];
            TWS_U16 setup_thr = 0x8000;

            CVT213X_LIB_LOG_E(1, "ph%d_setup cca %d ccb %d setup_thr %d base %d", index, setup_cca, setup_ccb, setup_thr, cvt213x_transfer_reg_to_data(g_setup_info_var.base[index - 1]));
            cvt213x_util_i2c_write_dword(chipIndex, 0x300c + 0x100 * index, setup_thr | (setup_cca << 16));
            cvt213x_util_i2c_write_dword(chipIndex, 0x3010 + 0x100 * index, setup_ccb);

            setup_cca = g_setup_info_var.cca[index - 3];
            setup_ccb = g_setup_info_var.ccb[index - 3];
            setup_thr = 0x8000;

            cvt213x_util_i2c_write_dword(chipIndex, 0x300c + 0x100 * (index - 2), setup_thr | (setup_cca << 16));
            cvt213x_util_i2c_write_dword(chipIndex, 0x3010 + 0x100 * (index - 2), setup_ccb);
        }
        cvt213x_ied_set_last_prox_state(0x18);
        g_setup_ph = 0x18;
    }
    else
    {
        CVT213X_LIB_LOG_E(0,"cvt213x_setup_info_check_validation failed");
    }
}

TWS_U8 cvt213x_setup_get_state(tws_chip_index_e chipIndex, TWS_U8 setup_ph)
{
    TWS_U8 state = 0;
    TWS_U8 index = 0;
    TWS_S32 sen_data[2] ={0};

    if(g_chip_func[chipIndex] & FUNC_SIG_IED)
    {
        index = 4;
    }
    else if(g_chip_func[chipIndex] & FUNC_DOU_IED)
    {
        index =3;
    }
    for (; index < 5; index++)
    {
        if (setup_ph & (0x01<<index))
        {
            TWS_U8 ph = index -3;
            sen_data[ph] = cvt213x_ied_get_data(chipIndex, 0x3030 + 0x100 * index);
            TWS_S32 ref_data = cvt213x_ied_get_data(chipIndex, 0x3030 + 0x100 * (index - 2));
            TWS_S32 ref_0c = cvt213x_transfer_reg_to_data(g_setup_info_var.base[index-3]);


            if (g_ied_flt_cnt == 0)
            {
                TWS_S32 base = cvt213x_transfer_reg_to_data(g_setup_info_var.base[index - 1]);
                g_ied_flt[ph].raw_mid_buf[0] = sen_data[ph];
                g_ied_flt[ph].raw_mid_buf[1] = sen_data[ph];
                g_ied_flt[ph].raw_mid_buf[2] = sen_data[ph];

                g_ied_flt[ph].ref_mid_buf[0] = ref_data;
                g_ied_flt[ph].ref_mid_buf[1] = ref_data;
                g_ied_flt[ph].ref_mid_buf[2] = ref_data;

                g_ied_flt[ph].base = base;
            }

            cvt213x_util_buf_push(g_ied_flt[ph].raw_mid_buf, sen_data[ph], 3);
            sen_data[ph] = cvt213x_ied_raw_median_filter(g_ied_flt[ph].raw_mid_buf[0], g_ied_flt[ph].raw_mid_buf[1], g_ied_flt[ph].raw_mid_buf[2]);

            cvt213x_util_buf_push(g_ied_flt[ph].ref_mid_buf, ref_data, 3);
            ref_data = cvt213x_ied_raw_median_filter(g_ied_flt[ph].ref_mid_buf[0], g_ied_flt[ph].ref_mid_buf[1], g_ied_flt[ph].ref_mid_buf[2]);

            sen_data[ph] -= (ref_data - ref_0c);
            g_ied_flt[ph].raw = sen_data[ph];

            //get diff
            g_ied_flt[ph].diff = g_ied_flt[ph].raw - g_ied_flt[ph].base;
            // CVT213X_LIB_LOG_D(3, "ph%d, sen_data: %d %d %d %d %d", index, g_ied_flt[ph].raw, ref_data, ref_0c, g_ied_flt[ph].base, g_ied_flt[ph].diff);

            if (g_ied_flt[ph].diff > (TWS_S32)g_phx_in_ear_thr[ph])
            {
                state |= (0x01<<index);
                g_ied_flt[ph].isInEar = 1;
            }
            else
            {
                state &= ~(0x01<<index);
                g_ied_flt[ph].isInEar = 0;

                // if (g_ied_flt[ph].diff < (-g_ph_noise_thr[ph]))
                if (g_ied_flt[ph].diff < (-(TWS_S32)g_phx_in_ear_thr[ph]))
                {
                    if (g_ied_flt[ph].dropCnt < 3)
                    {
                        g_ied_flt[ph].dropCnt++;
                    }

                    if (g_ied_flt[ph].dropCnt >= 3)
                    {
                        g_ied_flt[ph].base = cvt213x_ied_base_iir_filter(g_ied_flt[ph].raw, g_ied_flt[ph].base, 1, 64);
                    }
                }
                // else if (g_ied_flt[ph].diff < g_ph_noise_thr[ph])
                else if (g_ied_flt[ph].diff < ((TWS_S32)g_phx_in_ear_thr[ph]))
                {
                    g_ied_flt[ph].base = cvt213x_ied_base_iir_filter(g_ied_flt[ph].raw, g_ied_flt[ph].base, 1, 64);
                    g_ied_flt[ph].dropCnt = 0;
                }
                else
                {
                    g_ied_flt[ph].dropCnt = 0;
                }
            }
        }
    }
#if CVT213X_DROP_STEP_FUN
    if(g_chip_func[chipIndex] & FUNC_DOU_IED)
    {
        cvt213x_ied_drop_step_calc(chipIndex, &state,sen_data);
    }
#endif
    if (g_ied_flt_cnt == 0)
    {
        g_ied_flt_cnt = 1;
    }

    return state;
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void cvt213x_manual_reset_host(tws_chip_index_e chipIndex)
{
    CVT213X_LIB_LOG_E(0, "cvt213x_manual_reset_host() enter");

    g_setup_valid = 0;

    if ((cvt213x_is_earphone_in_box_state_get()) && (g_last_prox_state == 0))
    {
        TWS_U8 rd_dbg_fsm = 0x00;
        TWS_U8 proximity_state[1] = {0};
        TWS_U8 loop_cnt = 0;
        TWS_U8 rd_data[4] = {0};
        TWS_S32 ied_actual_box_diff[2] = {0};
        TWS_U8 index = 3;

        app_cvt213x_irq_disable();
        while (rd_dbg_fsm != 0x01)
        {
            CVT213X_LIB_LOG_D(1, "send idle err! retry!");

            cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
            cvt213x_util_delay(10);
            cvt213x_util_i2c_read(chipIndex, FSM_DBG, &rd_dbg_fsm, 1);

            loop_cnt++;
            if (loop_cnt >= 100)
            {
                return;
            }
        }

        cvt213x_i2c_clear_int(chipIndex);

        cvt213x_i2c_read_touch_state(chipIndex, proximity_state);

        if(g_chip_func[chipIndex] & FUNC_DOU_IED)
            index =3;
        else if(g_chip_func[chipIndex] & FUNC_SIG_IED)
            index =4;

        for (; index < 5; index++)
        {
            TWS_U8 i = 0;
            TWS_S32 max = 0,max_diff = 0;
            TWS_S32 min = 0,min_diff = 0;
            TWS_S32 raw = 0,diff =0;

            //get ref cc
            cvt213x_util_i2c_read(chipIndex, 0x3028 + 0x100 * (index - 2), rd_data, 4);
            g_setup_info_var.cca[index - 3] = ((rd_data[1] << 8) + (rd_data[0])) & 0x7FFF;
            g_setup_info_var.ccb[index - 3] = ((rd_data[3] << 8) + (rd_data[2])) & 0x7FFF;

            CVT213X_LIB_LOG_E(1, "setup_info_ph%d", index-2);
            CVT213X_LIB_LOG_E(1, "setup_info_cca: %d", g_setup_info_var.cca[index - 3]);
            CVT213X_LIB_LOG_E(1, "setup_info_ccb: %d", g_setup_info_var.ccb[index - 3]);

            //get ref 0c
            g_setup_info_var.base[index - 3] = g_phx_ref_use_0c[index - 3];
            CVT213X_LIB_LOG_E(1, "setup_info_ref_0c: %d\n", cvt213x_transfer_reg_to_data(g_setup_info_var.base[index - 3]));

            //get sen cc
            cvt213x_util_i2c_read(chipIndex, 0x3028 + 0x100 * index, rd_data, 4);
            g_setup_info_var.cca[index - 1] = ((rd_data[1] << 8) + (rd_data[0])) & 0x7FFF;
            g_setup_info_var.ccb[index - 1] = ((rd_data[3] << 8) + (rd_data[2])) & 0x7FFF;

            CVT213X_LIB_LOG_E(1, "setup_info_ph%d", index);
            CVT213X_LIB_LOG_E(1, "setup_info_cca: %d", g_setup_info_var.cca[index - 1]);
            CVT213X_LIB_LOG_E(1, "setup_info_ccb: %d", g_setup_info_var.ccb[index - 1]);

            //get sen base
            // cvt213x_util_i2c_read(chipIndex, 0x3034 + 0x100 * index, rd_data, 4);
            // g_setup_info_var.base[index - 1] = (rd_data[3] << 24) + (rd_data[2] << 16) + (rd_data[1] << 8) + (rd_data[0]);
            // CVT213X_LIB_LOG_E(1, "setup_info_raw1: %d", g_setup_info_var.base[index - 1]);
            for (i = 0; i < BOX_SAMPLE_NUM; i++)
            {
                TWS_S32 temp = cvt213x_ied_get_data(chipIndex, 0x3030 + 0x100 * index);//get rawdata
                TWS_S32 temp_diff = cvt213x_ied_get_data(chipIndex, 0x3038 + 0x100 * index);//get diff

                if (i == 0)
                {
                    max = temp;
                    min = temp;
                    max_diff = temp_diff;
                    min_diff = temp_diff;
                }

                if (temp > max)
                {
                    max = temp;
                }

                if (temp < min)
                {
                    min = temp;
                }

                if (temp_diff > max_diff)
                {
                    max_diff = temp_diff;
                }

                if (temp_diff < min_diff)
                {
                    min_diff = temp_diff;
                }

                raw += temp;
                diff +=temp_diff;
                CVT213X_LIB_LOG_W(1, "setup_info: box_raw:%d, box_diff:%d ", temp,temp_diff*2);

                cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_SCAN);
                cvt213x_util_delay(10);
                cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
                cvt213x_util_delay(10);
                cvt213x_util_i2c_read(chipIndex, FSM_DBG, &rd_dbg_fsm, 1);
                while (rd_dbg_fsm != 0x01)
                {
                    CVT213X_LIB_LOG_D(1, "send idle err! retry!");

                    cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_IDLE);
                    cvt213x_util_delay(10);
                    cvt213x_util_i2c_read(chipIndex, FSM_DBG, &rd_dbg_fsm, 1);

                    loop_cnt++;
                    if (loop_cnt >= 100)
                    {
                        return;
                    }
                }

            }
            cvt213x_i2c_clear_int(chipIndex);
            cvt213x_i2c_send_cmd(chipIndex, TWS_CMD_SCAN);

            raw -= max;
            raw -= min;
            raw /= (BOX_SAMPLE_NUM - 2);

            //diff calcu
            diff -=max_diff;
            diff -=min_diff;
            diff /= (BOX_SAMPLE_NUM - 2);
            diff =diff * 2;
            CVT213X_LIB_LOG_E(3, "setup_info: ph%d_box_raw:%d min:%d max:%d", index, raw, min, max);
            CVT213X_LIB_LOG_E(3, "setup_info: ph%d_box_diff:%d min:%d max:%d", index, diff, min_diff*2, max_diff*2);
#if CVT213X_TRX_EN
            if(cvt213x_get_cmd_mode_status() >= SETUP_CMD_READ)
#endif
            {
                raw -= g_box_raw_thr[index - 3];
                if(!(CVT213X_BOX_RAW_FIXED_EN))
                {
                    raw -= diff;                   
                }
            }
            CVT213X_LIB_LOG_E(1, "setup_info: ph%d_box_base:%d ", index, raw);

            g_setup_info_var.base[index - 1] = cvt213x_transfer_data_to_reg(raw);
            //CVT213X_LIB_LOG_E(1, "setup_info_raw1: %d", g_setup_info_var.base[index - 1]);
            CVT213X_LIB_LOG_E(1, "setup_info_raw1: %d\n", cvt213x_transfer_reg_to_data(g_setup_info_var.base[index - 1]));
            ied_actual_box_diff[index - 3] = diff; //用于判断是否将setup info写入flash
        }
        g_setup_info_var.last_prox_state = (proximity_state[0] & 0x18);
        CVT213X_LIB_LOG_E(1,"setup_info save ear state:0x%02x",g_setup_info_var.last_prox_state);
        g_setup_info_var.base[0] &= 0x001fffff;
        g_setup_info_var.base[1] &= 0x001fffff;

        g_setup_info_var.cfg_res[0] = 0xaa;
        cvt213x_setup_info_add_header_tail((TWS_U8 *)&g_setup_info_var, sizeof(g_setup_info_var));
        {
            for (index = 0; index < sizeof(g_setup_info_var); index++)
            {
                CVT213X_LIB_LOG_W(1, "0x%02x", *(((TWS_U8 *)&g_setup_info_var) + index));
            }
        }

        app_cvt213x_irq_enable();
        
        if(!(CVT213X_BOX_RAW_FIXED_EN))
        {
            if ((g_chip_func[chipIndex] & FUNC_DOU_IED) && (ied_actual_box_diff[0] > PH3_BOX_DIFF_THR) && (ied_actual_box_diff[1] > PH4_BOX_DIFF_THR)) //耳机在充电盒内重复初始化，setup info不写入flash
                g_setup_valid = 1;
            else if ((g_chip_func[chipIndex] & FUNC_SIG_IED) && (ied_actual_box_diff[1] > PH4_BOX_DIFF_THR))
                g_setup_valid = 1;
            else
                g_setup_valid = 0;
        }
        else
        {
            g_setup_valid = 1;
        }
        

#if CVT213X_TRX_EN
		if((cvt213x_get_cmd_mode_status() == SETUP_CMD_MP_WRITE)||(cvt213x_get_cmd_mode_status() == SETUP_CMD_APP_WRITE)) //MP/app mode , force set g_setup_valid value to 1
        {
            g_setup_valid = 1;
        }
#endif
    }
}
#endif
#endif
