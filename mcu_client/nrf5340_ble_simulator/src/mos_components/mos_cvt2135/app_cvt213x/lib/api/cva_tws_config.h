/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_config.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

#ifndef _CVA_TWS_CONFIG_H_
#define _CVA_TWS_CONFIG_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
* 1.Included files
*******************************************************************************/

/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/
/************************************双芯片选择**********************************/
#define DUAL_CVT213X_ENABLE             0

#define CVT213X_TRX_SLE                 TWS_CHIP_0
#define CVT213X_POWER_ON_SLE            TWS_CHIP_0

/************************************芯片选择**********************************/
// IC TYPE: IC_TYPE_CVT2133  IC_TYPE_CVT2135  IC_TYPE_CVT2138
#define CVT213X_IC_TYPE_SELECT          IC_TYPE_CVT2135

/************************************功能选择**********************************/
// #define FUNC_TYPE                   (FUNC_SIG_IED)
#define FUNC_TYPE                   (FUNC_DOU_IED)
// #define FUNC_TYPE                   (FUNC_TOUCH_ENABLE)
// #define FUNC_TYPE                   (FUNC_SLIDE_ENABLE)
// #define FUNC_TYPE                   (FUNC_SIG_IED | FUNC_TOUCH_ENABLE)
// #define FUNC_TYPE                   (FUNC_SIG_IED | FUNC_SLIDE_ENABLE)
// #define FUNC_TYPE                   (FUNC_DOU_IED | FUNC_TOUCH_ENABLE)
// #define FUNC_TYPE                   (FUNC_DOU_IED | FUNC_SLIDE_ENABLE)

/************************************log相关**********************************/
//log 总开关
#define FEATURE_DEBUG_LOG           1

#define CVT213X_APP_LOG_EN          1

#define CVT213X_LIB_LOG_EN          1

#define CVT213X_TRX_LOG_EN          1


/* Map legacy CVT213X_APP_LOG_* macros to Zephyr logging */
#include "app_cvt213x_log.h"

/*******************************TRX enable/disable*****************************/
#define CVT213X_TRX_EN              1

/*******************************flash enable/disable*****************************/
#define CVT213X_FLASH_EN            1

/*******************************sleep enable/disable*****************************/
#define CVT213X_HOST_SLEEP_EN       0

/*******************************IED TK combine enable/disable*****************************/
#define CVT213X_IED_TK_SEPARATE_EN   0

/*******************************button calc by sdk*****************************/
#define CVT213X_TK_CALC_BY_SDK       0

/*******************************drop func*************************************/
//only two ear detect can enable
#define CVT213X_DROP_STEP_FUN               0
#define PH_SLOPE_SETP_RAW                   5000
#define PH3_DROP_STEP_RAW                   50000
#define PH4_DROP_STEP_RAW                   50000
#define DROP_STEP_TIMER                     300
#define IED_PH3_INEAR_DROP_DEBOUNCE_NUM     50

/*******************************setup func*************************************/
//use save ear offset value calc ear detect
#define CVT213X_SETUP_FUN            0//1
#define CVT213X_SETUP_PH3_THR        (((PH3_THRE*PH3_THRE)<<PH3_FACT)>>1)
#define CVT213X_SETUP_PH4_THR        (((PH4_THRE*PH4_THRE)<<PH4_FACT)>>1)
#define CVT213X_BOX_RAW_FIXED_EN     0
#define PH3_BOX_RAW                  0
#define PH4_BOX_RAW                  0
#define PH3_NOISE_THR                10000              //unused
#define PH4_NOISE_THR                10000              //unused
#define BOX_SAMPLE_NUM               10
//skip repeat call  cvt213x_manual_reset_host,write error value to flash
#define PH3_BOX_DIFF_THR             20000              
#define PH4_BOX_DIFF_THR             20000

/************************************手势相关**********************************/
#define LONG_PRESS_THRE             150                 //长按阈值，取值范围0x0000~0xFFFE
#define LONG_PRESS_REPEAT_EN        0                   //长按续报使能 1:true 0:false
#define LONG_PRESS_REPEAT_THRE      60                  //长按续报阈值，取值范围0x0000~0xFFFF
#define DOUBLE_CLICK_THRE           45                  //双击抬手阈值，取值范围0x00~0xFF
#define PUSH_THRE                   1                   //按下毛刺阈值，取值范围0x00~0xFF
#define RELESE_THRE                 1                   //抬起防抖阈值，取值范围0x00~0xFF
#define SLIDE_THRE                  3                   //滑动空间阈值，取值范围0x01~0x04
#define SLIDE_REPEAT_EN             0                   //滑动续报使能 1:true 0:false
#define SLIDE_REPEAT_THR            50                 //滑动续报时间阈值，取值范围0x01~0x04
#define CLICK_NUM_EN                0x1F                //单击次数使能，bit0：使能单击；bit1：使能双击...bit7：使能八击
#define CLICK_AND_LONG_PRESS_EN     0x1F                //触摸+长按事件使能，bit0：使能单击长按；bit1：使能双击长按...bit7：使能八击长按
#define CLICK_AND_LONG_PRESS_THRE   500                 //触摸+长按事件的长按时间阈值，每个step为1个扫描周期

#define LONGLONG_PRESS_THRE          500
#define FIX_COMPENSATION_THRE        600
#define FIX_COMPENSATION_THRE_CHARGE 800

#define CLICK_SUPPRESSION           0                   //suppression click event if click count exceed CLICK_NUM_THR

/************************************佩戴相关**********************************/
#define IED_ON_DEBOUNCE_NUM                 2
#define IED_OFF_DEBOUNCE_NUM                3

#define IED_DESKTOP_DIFF_THR                27000
/************************************扫描相关**********************************/
// Default mode扫描相关配置 start
// Phase0时间段CSIO功能
// 取值范围：0x04:HZ; 0x05:input; 0x06:Dynamic Shield; 0x07:GND
#define PH0_SCIO0_SEL               0x07U               //CS0 usage in Phase0
#define PH0_SCIO1_SEL               0x07U               //CS1 usage in Phase0
#define PH0_SCIO2_SEL               0x07U               //CS2 usage in Phase0
#define PH0_SCIO3_SEL               0x07U               //CS3 usage in Phase0
#define PH0_SCIO4_SEL               0x07U               //CS4 usage in Phase0
#define PH0_SCIO5_SEL               0x07U               //CS5 usage in Phase0
#define PH0_SCIO6_SEL               0x07U               //CS6 usage in Phase0
#define PH0_SCIO7_SEL               0x07U               //CS7 usage in Phase0

// Phase1时间段CSIO功能
// 取值范围：0x04:HZ; 0x05:input; 0x06:Dynamic Shield; 0x07:GND
#define PH1_SCIO0_SEL               0x07U               //CS0 usage in Phase1
#define PH1_SCIO1_SEL               0x07U               //CS1 usage in Phase1
#define PH1_SCIO2_SEL               0x07U               //CS2 usage in Phase1
#define PH1_SCIO3_SEL               0x05U               //CS3 usage in Phase1
#define PH1_SCIO4_SEL               0x07U               //CS4 usage in Phase1
#define PH1_SCIO5_SEL               0x07U               //CS5 usage in Phase1
#define PH1_SCIO6_SEL               0x07U               //CS6 usage in Phase1
#define PH1_SCIO7_SEL               0x07U               //CS7 usage in Phase1

// Phase2时间段CSIO功能
// 取值范围：0x04:HZ; 0x05:input; 0x06:Dynamic Shield; 0x07:GND
#define PH2_SCIO0_SEL               0x05U               //CS0 usage in Phase2
#define PH2_SCIO1_SEL               0x07U               //CS1 usage in Phase2
#define PH2_SCIO2_SEL               0x07U               //CS2 usage in Phase2
#define PH2_SCIO3_SEL               0x07U               //CS3 usage in Phase2
#define PH2_SCIO4_SEL               0x07U               //CS4 usage in Phase2
#define PH2_SCIO5_SEL               0x07U               //CS5 usage in Phase2
#define PH2_SCIO6_SEL               0x07U               //CS6 usage in Phase2
#define PH2_SCIO7_SEL               0x07U               //CS7 usage in Phase2

// Phase3时间段CSIO功能
// 取值范围：0x04:HZ; 0x05:input; 0x06:Dynamic Shield; 0x07:GND
#define PH3_SCIO0_SEL               0x07U               //CS0 usage in Phase3
#define PH3_SCIO1_SEL               0x07U               //CS1 usage in Phase3
#define PH3_SCIO2_SEL               0x07U               //CS2 usage in Phase3
#define PH3_SCIO3_SEL               0x07U               //CS3 usage in Phase3
#define PH3_SCIO4_SEL               0x05U               //CS4 usage in Phase3
#define PH3_SCIO5_SEL               0x07U               //CS5 usage in Phase3
#define PH3_SCIO6_SEL               0x07U               //CS6 usage in Phase3
#define PH3_SCIO7_SEL               0x07U               //CS7 usage in Phase3

// Phase4时间段CSIO功能
// 取值范围：0x04:HZ; 0x05:input; 0x06:Dynamic Shield; 0x07:GND
#define PH4_SCIO0_SEL               0x07U               //CS0 usage in Phase4
#define PH4_SCIO1_SEL               0x05U               //CS1 usage in Phase4
#define PH4_SCIO2_SEL               0x07U               //CS2 usage in Phase4
#define PH4_SCIO3_SEL               0x07U               //CS3 usage in Phase4
#define PH4_SCIO4_SEL               0x07U               //CS4 usage in Phase4
#define PH4_SCIO5_SEL               0x07U               //CS5 usage in Phase4
#define PH4_SCIO6_SEL               0x07U               //CS6 usage in Phase4
#define PH4_SCIO7_SEL               0x07U               //CS7 usage in Phase4

// Phase5时间段CSIO功能
// 取值范围：0x04:HZ; 0x05:input; 0x06:Dynamic Shield; 0x07:GND
#define PH5_SCIO0_SEL               0x07U               //CS0 usage in Phase5
#define PH5_SCIO1_SEL               0x07U               //CS1 usage in Phase5
#define PH5_SCIO2_SEL               0x07U               //CS2 usage in Phase5
#define PH5_SCIO3_SEL               0x07U               //CS3 usage in Phase5
#define PH5_SCIO4_SEL               0x07U               //CS4 usage in Phase5
#define PH5_SCIO5_SEL               0x07U               //CS5 usage in Phase5
#define PH5_SCIO6_SEL               0x07U               //CS6 usage in Phase5
#define PH5_SCIO7_SEL               0x07U               //CS7 usage in Phase5

// Phase6时间段CSIO功能
// 取值范围：0x04:HZ; 0x05:input; 0x06:Dynamic Shield; 0x07:GND
#define PH6_SCIO0_SEL               0x07U               //CS0 usage in Phase6
#define PH6_SCIO1_SEL               0x07U               //CS1 usage in Phase6
#define PH6_SCIO2_SEL               0x07U               //CS2 usage in Phase6
#define PH6_SCIO3_SEL               0x07U               //CS3 usage in Phase6
#define PH6_SCIO4_SEL               0x07U               //CS4 usage in Phase6
#define PH6_SCIO5_SEL               0x07U               //CS5 usage in Phase6
#define PH6_SCIO6_SEL               0x07U               //CS6 usage in Phase6
#define PH6_SCIO7_SEL               0x07U               //CS7 usage in Phase6

// Phase7时间段CSIO功能
// 取值范围：0x04:HZ; 0x05:input; 0x06:Dynamic Shield; 0x07:GND
#define PH7_SCIO0_SEL               0x07U               //CS0 usage in Phase7
#define PH7_SCIO1_SEL               0x07U               //CS1 usage in Phase7
#define PH7_SCIO2_SEL               0x07U               //CS2 usage in Phase7
#define PH7_SCIO3_SEL               0x07U               //CS3 usage in Phase7
#define PH7_SCIO4_SEL               0x07U               //CS4 usage in Phase7
#define PH7_SCIO5_SEL               0x07U               //CS5 usage in Phase7
#define PH7_SCIO6_SEL               0x07U               //CS6 usage in Phase7
#define PH7_SCIO7_SEL               0x07U               //CS7 usage in Phase7

// 打码频率
// 取值范围： 0x01:250KHz; 0x02:138.8KHz; 0x03:73.5KHz
#define PH0_FREQUENCY               0x01U               //Phase0 sample freq, 250KHz
#define PH1_FREQUENCY               0x01U               //Phase1 sample freq, 250KHz
#define PH2_FREQUENCY               0x01U               //Phase2 sample freq, 250KHz
#define PH3_FREQUENCY               0x01U               //Phase3 sample freq, 250KHz
#define PH4_FREQUENCY               0x01U               //Phase4 sample freq, 250KHz
#define PH5_FREQUENCY               0x01U               //Phase5 sample freq, 250KHz
#define PH6_FREQUENCY               0x01U               //Phase6 sample freq, 250KHz
#define PH7_FREQUENCY               0x01U               //Phase7 sample freq, 250KHz

// 积分次数
// 取值范围：0x00:8次; 0x01:16次; 0x02:32次; 0x03:64次
#define PH0_RESOLUTION              0x02U               //Phase0 resolution cnt, 16
#define PH1_RESOLUTION              0x02U               //Phase1 resolution cnt, 16
#define PH2_RESOLUTION              0x02U               //Phase2 resolution cnt, 16
#define PH3_RESOLUTION              0x02U               //Phase3 resolution cnt, 16
#define PH4_RESOLUTION              0x02U               //Phase4 resolution cnt, 16
#define PH5_RESOLUTION              0x02U               //Phase5 resolution cnt, 16
#define PH6_RESOLUTION              0x02U               //Phase6 resolution cnt, 16
#define PH7_RESOLUTION              0x02U               //Phase7 resolution cnt, 16

// shielding开关
// 取值范围：0x00:Disable; 0x01:Enable
#define PH0_SHD_EN                  0x00U               //Phase0 shielding driver: Disable
#define PH1_SHD_EN                  0x00U               //Phase1 shielding driver: Disable
#define PH2_SHD_EN                  0x00U               //Phase2 shielding driver: Disable
#define PH3_SHD_EN                  0x00U               //Phase3 shielding driver: Disable
#define PH4_SHD_EN                  0x00U               //Phase4 shielding driver: Disable
#define PH5_SHD_EN                  0x00U               //Phase5 shielding driver: Disable
#define PH6_SHD_EN                  0x00U               //Phase6 shielding driver: Disable
#define PH7_SHD_EN                  0x00U               //Phase7 shielding driver: Disable

// 反馈电容
// 取值范围：0x00:0.55pF; 0x01:1.10pF; 0x02:1.65pF; 0x03:2.20pF; 0x04:3.30pF; 0x05:3.85pF; 0x06:4.40pF; 0x07:4.95pF
//           0x08:5.50pF; 0x09:6.05pF; 0x0A:6.60pF; 0x0B:7.15pF; 0x0C:8.25pF; 0x0D:8.80pF; 0x0E:9.35pF; 0x0F:9.90pF
#define PH0_CF_SEL                  0x07U               //Phase0 feedback capacitabce
#define PH1_CF_SEL                  0x07U               //Phase1 feedback capacitabce
#define PH2_CF_SEL                  0x07U               //Phase2 feedback capacitabce
#define PH3_CF_SEL                  0x07U               //Phase3 feedback capacitabce
#define PH4_CF_SEL                  0x07U               //Phase4 feedback capacitabce
#define PH5_CF_SEL                  0x07U               //Phase5 feedback capacitabce
#define PH6_CF_SEL                  0x07U               //Phase6 feedback capacitabce
#define PH7_CF_SEL                  0x07U               //Phase7 feedback capacitabce

// raw data filter
// 取值范围：0x00:0(关闭); 0x01:1-1/2; 0x02:1-1/4; 0x03:1-1/8; 0x04:1-1/16; 0x05:1-1/32; 0x06:1-1/64; 0x07:1-1/128
#define PH0_RAWFLT                  0x00U               //Phase0 raw data filter coefficient
#define PH1_RAWFLT                  0x00U               //Phase1 raw data filter coefficient
#define PH2_RAWFLT                  0x00U               //Phase2 raw data filter coefficient
#define PH3_RAWFLT                  0x00U               //Phase3 raw data filter coefficient
#define PH4_RAWFLT                  0x00U               //Phase4 raw data filter coefficient
#define PH5_RAWFLT                  0x00U               //Phase5 raw data filter coefficient
#define PH6_RAWFLT                  0x00U               //Phase6 raw data filter coefficient
#define PH7_RAWFLT                  0x00U               //Phase7 raw data filter coefficient

// average data正向滤波器
// 取值范围：0x00:0 关闭; 0x01:1-1/32; 0x02:1-1/64; 0x03:1-1/128; 0x04:1-1/256; 0x05:1-1/512; 0x06:1-1/1024; 0x07:1(无限接近)
#define PH0_AVGFLT_POS              0x01U               //Phase0 average data positive filter coefficient
#define PH1_AVGFLT_POS              0x01U               //Phase1 average data positive filter coefficient
#define PH2_AVGFLT_POS              0x01U               //Phase2 average data positive filter coefficient
#define PH3_AVGFLT_POS              0x01U               //Phase3 average data positive filter coefficient
#define PH4_AVGFLT_POS              0x01U               //Phase4 average data positive filter coefficient
#define PH5_AVGFLT_POS              0x01U               //Phase5 average data positive filter coefficient
#define PH6_AVGFLT_POS              0x01U               //Phase6 average data positive filter coefficient
#define PH7_AVGFLT_POS              0x01U               //Phase7 average data positive filter coefficient

// average data负向滤波器
// 取值范围：0x00:0(关闭); 0x01:1-1/2; 0x02:1-1/4; 0x03:1-1/8; 0x04:1-1/16; 0x05:1-1/32; 0x06:1-1/64; 0x07:1(无限接近)
#define PH0_AVGFLT_NEG              0x01U               //Phase0 average data negative filter coefficient
#define PH1_AVGFLT_NEG              0x01U               //Phase1 average data negative filter coefficient
#define PH2_AVGFLT_NEG              0x01U               //Phase2 average data negative filter coefficient
#define PH3_AVGFLT_NEG              0x01U               //Phase3 average data negative filter coefficient
#define PH4_AVGFLT_NEG              0x01U               //Phase4 average data negative filter coefficient
#define PH5_AVGFLT_NEG              0x01U               //Phase5 average data negative filter coefficient
#define PH6_AVGFLT_NEG              0x01U               //Phase6 average data negative filter coefficient
#define PH7_AVGFLT_NEG              0x01U               //Phase7 average data negative filter coefficient

// 触摸阈值由threshold和factor共同决定
// 如果threshold <= 1, 触摸阈值 = threshold; 如果threshold > 1，触摸阈值 = int(PHx_THRE^2/2) * 2^PHx_FACT
// threshold 取值范围：0x00 ~ 0xFF
#define PH0_THRE                    0x8dU               //Phase0 threshold
#define PH1_THRE                    0xFFU               //Phase1 threshold
#define PH2_THRE                    0xFFU               //Phase2 threshold
#define PH3_THRE                    0x8dU               //Phase3 threshold
#define PH4_THRE                    0x8dU               //Phase4 threshold
#define PH5_THRE                    0x8dU               //Phase5 threshold
#define PH6_THRE                    0x8dU               //Phase6 threshold
#define PH7_THRE                    0x8dU               //Phase7 threshold
// factor 取值范围：0x00 ~ 0x06
#define PH0_FACT                    0x01U               //Phase0 factor
#define PH1_FACT                    0x06U               //Phase1 factor
#define PH2_FACT                    0x06U               //Phase2 factor
#define PH3_FACT                    0x01U               //Phase3 factor
#define PH4_FACT                    0x01U               //Phase4 factor
#define PH5_FACT                    0x01U               //Phase5 factor
#define PH6_FACT                    0x01U               //Phase6 factor
#define PH7_FACT                    0x01U               //Phase7 factor

// 去抖动滤波
// close debouncer
// 取值范围： 0x00:OFF; 0x01:2 samples; 0x02:4 samples; 0x03:8 samples
#define PH0_CLOSEDEB                0x00U               //Phase0 close debouncer
#define PH1_CLOSEDEB                0x00U               //Phase1 close debouncer
#define PH2_CLOSEDEB                0x00U               //Phase2 close debouncer
#define PH3_CLOSEDEB                0x01U               //Phase3 close debouncer
#define PH4_CLOSEDEB                0x01U               //Phase4 close debouncer
#define PH5_CLOSEDEB                0x00U               //Phase5 close debouncer
#define PH6_CLOSEDEB                0x00U               //Phase6 close debouncer
#define PH7_CLOSEDEB                0x00U               //Phase7 close debouncer

#define PH0_CLOSEDEB_HOST_SLEEP     0x02U               //Phase0 close debouncer
#define PH1_CLOSEDEB_HOST_SLEEP     0x00U               //Phase1 close debouncer
#define PH2_CLOSEDEB_HOST_SLEEP     0x00U               //Phase2 close debouncer
#define PH3_CLOSEDEB_HOST_SLEEP     0x00U               //Phase3 close debouncer
#define PH4_CLOSEDEB_HOST_SLEEP     0x00U               //Phase4 close debouncer
#define PH5_CLOSEDEB_HOST_SLEEP     0x00U               //Phase5 close debouncer
#define PH6_CLOSEDEB_HOST_SLEEP     0x00U               //Phase6 close debouncer
#define PH7_CLOSEDEB_HOST_SLEEP     0x00U               //Phase7 close debouncer

// far debouncer
// 取值范围： 0x00:OFF; 0x01:2 samples; 0x02:4 samples; 0x03:8 samples
#define PH0_FARDEB                  0x00U               //Phase0 far debouncer
#define PH1_FARDEB                  0x00U               //Phase1 far debouncer
#define PH2_FARDEB                  0x00U               //Phase2 far debouncer
#define PH3_FARDEB                  0x01U               //Phase3 far debouncer
#define PH4_FARDEB                  0x01U               //Phase4 far debouncer
#define PH5_FARDEB                  0x00U               //Phase5 far debouncer
#define PH6_FARDEB                  0x00U               //Phase6 far debouncer
#define PH7_FARDEB                  0x00U               //Phase7 far debouncer

// 中断使能
// 取值范围: IRQ: 0x02:close; 0x04:far; 0x08:compensation; 0x10:conversion; 0x100:closeand; 0x200:farand
//           closeand_cfg:0x00~0xFF(每一bit表示Phase7~0)
//           farand_cfg:0x00~0xFF(每一bit表示Phase7~0)
#define DEFAULT_IRQ                 0x0010U              //Default mode IRQ enable
#define DEFAULT_CLOSEAND            0x00U                //Defaukt mode closeand channel seletcion
#define DEFAULT_FARAND              0x00U                //Defaukt mode farand  channel seletcion

#define DOZE_IRQ                    0x0006U              //Doze mode IRQ enable
#define DOZE_CLOSEAND               0x00U                //Doze mode closeand channel seletcion
#define DOZE_FARAND                 0x00U                //Doze mode farand channel seletcion

#define HOST_SLEEP_IRQ              0x0002U              //Host sleep mode IRQ enable
#define HOST_SLEEP_CLOSEAND         0x00U                //Host sleep mode closeand channel seletcion
#define HOST_SLEEP_FARAND           0x00U                //Host sleep mode farand channel seletcion

// 扫描周期
// 取值范围：0x0000~0x07FF,scan period时长。大约2ms的步长。最长不能超过4s，假如超过4s，会自动固定到4s。
#define DEFAULT_SCAN                0x0005U             //Default mode scan period
#define DOZE_SCAN                   0x0019U// 0x0005U             //Doze mode scan period
#define HOST_SLEEP_SCAN             0x00FAU             //Host sleep mode scan period 250*2ms = 500ms

// reference function
// 取值范围： REF_EN：0x00:Disable; 0x01:Enable
//            REF_PHASE:0x00~0xfF(每一bit表示Phase7~0)
#define REF_EN                      0x01U                //reference function enable
#define REF_PHASE                   0x06U                //reference Phase
// 各phase correction
// reference source 修正参考通道
// 取值范围：REFSRC：0x00:Phase0; 0x01:Phase1; 0x02:Phase2; 0x03:Phase3; 0x04:Phase4; 0x05:Phase5; 0x06:Phase6; 0x07:Phase7;，不允许自己参考自己,选择范围是REF_PHASE中的phase
#define PH0_REFSRC                  0x00U                //Phase0 reference src: none
#define PH1_REFSRC                  0x00U                //Phase1 reference src: none
#define PH2_REFSRC                  0x00U                //Phase2 reference src: none
#define PH3_REFSRC                  0x01U                //Phase3 reference src: none
#define PH4_REFSRC                  0x02U                //Phase4 reference src: none
#define PH5_REFSRC                  0x00U                //Phase5 reference src: none
#define PH6_REFSRC                  0x00U                //Phase6 reference src: none
#define PH7_REFSRC                  0x00U                //Phase7 reference src: none
// correction enable 修正使能
// 取值范围：COR_EN：0x00:Disable; 0x01:Enable
#define PH0_COR_EN                  0x00U                //Phase0 correction: disable
#define PH1_COR_EN                  0x00U                //Phase1 correction: disable
#define PH2_COR_EN                  0x00U                //Phase2 correction: disable
#define PH3_COR_EN                  0x01U                //Phase3 correction: disable
#define PH4_COR_EN                  0x01U                //Phase4 correction: disable
#define PH5_COR_EN                  0x00U                //Phase5 correction: disable
#define PH6_COR_EN                  0x00U                //Phase6 correction: disable
#define PH7_COR_EN                  0x00U                //Phase7 correction: disable
// COEF 修正系数
// 取值范围：COEF：0x00~0xFF
#define PH0_COEF                    0x00U                //Phase0 correction coefficient
#define PH1_COEF                    0x00U                //Phase1 correction coefficient
#define PH2_COEF                    0x00U                //Phase2 correction coefficient
#define PH3_COEF                    0x20U                //Phase3 correction coefficient
#define PH4_COEF                    0x20U                //Phase4 correction coefficient
#define PH5_COEF                    0x00U                //Phase5 correction coefficient
#define PH6_COEF                    0x00U                //Phase6 correction coefficient
#define PH7_COEF                    0x00U                //Phase7 correction coefficient

//通道使能
//取值范围：COMPEN：0x00~0xFF(每一bit表示Phase7~0)
//          PHEN：0x00~0xFF(每一bit表示Phase7~0) active mode与doze mode一致
#define DEFAULT_COMPEN              0x1EU                //Default mode compensation phase
#define DEFAULT_PHEN                0x1EU                //Default mode scan phase
#define DOZE_COMPEN                 0x1EU                //Doze mode compensation phase
#define DOZE_PHEN                   0x1EU                //Doze mode scan phase
#define HOST_SLEEP_COMPEN           0x1EU                //Host sleep mode compensation phase
#define HOST_SLEEP_PHEN             0x1EU                //Host sleep mode scan phase
// 扫描相关配置 end

/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/
typedef enum
{
    TWS_CHIP_0 = 0x00,
#if DUAL_CVT213X_ENABLE
    TWS_CHIP_1 = 0x01,
#endif

    TWS_CHIP_NUM,
} tws_chip_index_e;

/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/

/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/

#ifdef __cplusplus
}
#endif

#endif

