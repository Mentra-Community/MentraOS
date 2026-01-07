/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_sys_def.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

#ifndef _CVA_TWS_SYS_DEF_H_
#define _CVA_TWS_SYS_DEF_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
* 1.Included files
*******************************************************************************/
#include "cva_tws_config.h"
#include "app_cvt213x_porting.h"

/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/

/************************************功能选择**********************************/
#define FUNC_SIG_IED                0x01    //单点入耳检测
#define FUNC_DOU_IED                0x02    //双点入耳检测，注意不能同时选择单点和双点入耳检测
#define FUNC_TOUCH_ENABLE           0x04    //单点触摸
#define FUNC_SLIDE_ENABLE           0x08    //一维滑动，注意不能同时选择单点触摸和一维滑动

/********************************LOG LEVEL选择********************************/
#ifndef LOG_LEVEL_DBG
#define LOG_LEVEL_DBG 0x01
#endif
#ifndef LOG_LEVEL_WRO
#define LOG_LEVEL_WRO 0x02
#endif
#ifndef LOG_LEVEL_ERR
#define LOG_LEVEL_ERR 0x03
#endif

/********************************IC TYPE选择********************************/
#define IC_TYPE_CVT2133               0x01
#define IC_TYPE_CVT2135               0x02
#define IC_TYPE_CVT2138               0x04

/************************************I2C相关**********************************/
#define      CVT213X_AFEC_CTRL0_PH0         0x2100
#define      CVT213X_AFEC_CTRL0_PH1         0x2110
#define      CVT213X_AFEC_CTRL0_PH2         0x2120
#define      CVT213X_AFEC_CTRL0_PH3         0x2130
#define      CVT213X_AFEC_CTRL0_PH4         0x2140
#define      CVT213X_AFEC_CTRL0_PH5         0x2150
#define      CVT213X_AFEC_CTRL0_PH6         0x2160
#define      CVT213X_AFEC_CTRL0_PH7         0x2170

#define      CVT213X_AFEC_CTRL1_PH0         0x2104
#define      CVT213X_AFEC_CTRL1_PH1         0x2114
#define      CVT213X_AFEC_CTRL1_PH2         0x2124
#define      CVT213X_AFEC_CTRL1_PH3         0x2134
#define      CVT213X_AFEC_CTRL1_PH4         0x2144
#define      CVT213X_AFEC_CTRL1_PH5         0x2154
#define      CVT213X_AFEC_CTRL1_PH6         0x2164
#define      CVT213X_AFEC_CTRL1_PH7         0x2174

#define      CVT213X_PROC_RAWFLT_PH0        0x3000
#define      CVT213X_PROC_RAWFLT_PH1        0x3100
#define      CVT213X_PROC_RAWFLT_PH2        0x3200
#define      CVT213X_PROC_RAWFLT_PH3        0x3300
#define      CVT213X_PROC_RAWFLT_PH4        0x3400
#define      CVT213X_PROC_RAWFLT_PH5        0x3500
#define      CVT213X_PROC_RAWFLT_PH6        0x3600
#define      CVT213X_PROC_RAWFLT_PH7        0x3700

#define      CVT213X_PROC_AVGFLT_PH0        0x3004
#define      CVT213X_PROC_AVGFLT_PH1        0x3104
#define      CVT213X_PROC_AVGFLT_PH2        0x3204
#define      CVT213X_PROC_AVGFLT_PH3        0x3304
#define      CVT213X_PROC_AVGFLT_PH4        0x3404
#define      CVT213X_PROC_AVGFLT_PH5        0x3504
#define      CVT213X_PROC_AVGFLT_PH6        0x3604
#define      CVT213X_PROC_AVGFLT_PH7        0x3704

#define      CVT213X_PROC_DIFF_PH0          0x3014
#define      CVT213X_PROC_DIFF_PH1          0x3114
#define      CVT213X_PROC_DIFF_PH2          0x3214
#define      CVT213X_PROC_DIFF_PH3          0x3314
#define      CVT213X_PROC_DIFF_PH4          0x3414
#define      CVT213X_PROC_DIFF_PH5          0x3514
#define      CVT213X_PROC_DIFF_PH6          0x3614
#define      CVT213X_PROC_DIFF_PH7          0x3714

#define      CVT213X_FSM_IRQNEN             0x0004
#define      CVT213X_FSM_CTRL0              0x0028
#define      CVT213X_FSM_CTRL1              0x002C

#define      CVT213X_PROC_COR_PH0           0x302c
#define      CVT213X_PROC_COR_PH1           0x312c
#define      CVT213X_PROC_COR_PH2           0x322c
#define      CVT213X_PROC_COR_PH3           0x332c
#define      CVT213X_PROC_COR_PH4           0x342c
#define      CVT213X_PROC_COR_PH5           0x352c
#define      CVT213X_PROC_COR_PH6           0x362c
#define      CVT213X_PROC_COR_PH7           0x372c

#define      CVT213X_PROC_AVG_PH0           0x3008
#define      CVT213X_PROC_AVG_PH1           0x3108
#define      CVT213X_PROC_AVG_PH2           0x3208
#define      CVT213X_PROC_AVG_PH3           0x3308
#define      CVT213X_PROC_AVG_PH4           0x3408
#define      CVT213X_PROC_AVG_PH5           0x3508
#define      CVT213X_PROC_AVG_PH6           0x3608
#define      CVT213X_PROC_AVG_PH7           0x3708

#if ((CVT213X_IC_TYPE_SELECT & IC_TYPE_CVT2133) || (CVT213X_IC_TYPE_SELECT & IC_TYPE_CVT2135))

#define CVT213X_REG_NUM         0x0000
#define REG_DEFAULT_NUM         0x0000001F
#define REG_INIT_NUM            0x0000000B
#define REG_DOZE_NUM            0x00000004
#define REG_HOST_SLEEP_NUM      0x0000000C
#define REG_HOST_WAKEUP_NUM     0x0000000C

#define REG_DEFAULT { \
    { CVT213X_REG_NUM,          REG_DEFAULT_NUM},\
    { CVT213X_AFEC_CTRL0_PH0,   PH0_SCIO0_SEL | (PH0_SCIO1_SEL << 3) | (PH0_SCIO2_SEL << 6) | (PH0_SCIO3_SEL << 9) | (PH0_SCIO4_SEL << 12)},\
    { CVT213X_AFEC_CTRL0_PH1,   PH1_SCIO0_SEL | (PH1_SCIO1_SEL << 3) | (PH1_SCIO2_SEL << 6) | (PH1_SCIO3_SEL << 9) | (PH1_SCIO4_SEL << 12)},\
    { CVT213X_AFEC_CTRL0_PH2,   PH2_SCIO0_SEL | (PH2_SCIO1_SEL << 3) | (PH2_SCIO2_SEL << 6) | (PH2_SCIO3_SEL << 9) | (PH2_SCIO4_SEL << 12)},\
    { CVT213X_AFEC_CTRL0_PH3,   PH3_SCIO0_SEL | (PH3_SCIO1_SEL << 3) | (PH3_SCIO2_SEL << 6) | (PH3_SCIO3_SEL << 9) | (PH3_SCIO4_SEL << 12)},\
    { CVT213X_AFEC_CTRL0_PH4,   PH4_SCIO0_SEL | (PH4_SCIO1_SEL << 3) | (PH4_SCIO2_SEL << 6) | (PH4_SCIO3_SEL << 9) | (PH4_SCIO4_SEL << 12)},\
    { CVT213X_AFEC_CTRL1_PH0,   0x03035040 | PH0_FREQUENCY | (PH0_RESOLUTION << 8) | (PH0_SHD_EN << 11) | (PH0_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH1,   0x03035040 | PH1_FREQUENCY | (PH1_RESOLUTION << 8) | (PH1_SHD_EN << 11) | (PH1_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH2,   0x03035040 | PH2_FREQUENCY | (PH2_RESOLUTION << 8) | (PH2_SHD_EN << 11) | (PH2_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH3,   0x03035040 | PH3_FREQUENCY | (PH3_RESOLUTION << 8) | (PH3_SHD_EN << 11) | (PH3_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH4,   0x03035040 | PH4_FREQUENCY | (PH4_RESOLUTION << 8) | (PH4_SHD_EN << 11) | (PH4_CF_SEL << 28)},\
    { CVT213X_PROC_RAWFLT_PH0,  (PH0_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH1,  (PH1_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH2,  (PH2_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH3,  (PH3_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH4,  (PH4_RAWFLT << 8)},\
    { CVT213X_PROC_DIFF_PH0,    PH0_THRE | (PH0_FACT << 8) | (PH0_CLOSEDEB << 16) | (PH0_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH1,    PH1_THRE | (PH1_FACT << 8) | (PH1_CLOSEDEB << 16) | (PH1_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH2,    PH2_THRE | (PH2_FACT << 8) | (PH2_CLOSEDEB << 16) | (PH2_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH3,    PH3_THRE | (PH3_FACT << 8) | (PH3_CLOSEDEB << 16) | (PH3_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH4,    PH4_THRE | (PH4_FACT << 8) | (PH4_CLOSEDEB << 16) | (PH4_FARDEB << 18)},\
    { CVT213X_FSM_IRQNEN,       DEFAULT_IRQ | (DEFAULT_CLOSEAND << 16) | (DEFAULT_FARAND << 24)},\
    { CVT213X_FSM_CTRL0,        DEFAULT_SCAN | (REF_PHASE << 16)},\
    { CVT213X_FSM_CTRL1,        DEFAULT_COMPEN | (DEFAULT_PHEN << 16) | (REF_EN << 26)},\
    { CVT213X_PROC_COR_PH0,     PH0_REFSRC | (PH0_COR_EN << 16) | (PH0_COEF << 24)},\
    { CVT213X_PROC_COR_PH1,     PH1_REFSRC | (PH1_COR_EN << 16) | (PH1_COEF << 24)},\
    { CVT213X_PROC_COR_PH2,     PH2_REFSRC | (PH2_COR_EN << 16) | (PH2_COEF << 24)},\
    { CVT213X_PROC_COR_PH3,     PH3_REFSRC | (PH3_COR_EN << 16) | (PH3_COEF << 24)},\
    { CVT213X_PROC_COR_PH4,     PH4_REFSRC | (PH4_COR_EN << 16) | (PH4_COEF << 24)},\
    { CVT213X_PROC_AVGFLT_PH1,  0x07U | (0x07U << 4)},\
    { CVT213X_PROC_AVGFLT_PH2,  0x07U | (0x07U << 4)},\
}

#define REG_INIT { \
    { CVT213X_REG_NUM,          REG_INIT_NUM},\
    { CVT213X_PROC_AVGFLT_PH0,  PH0_AVGFLT_POS | (PH0_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH1,  PH1_AVGFLT_POS | (PH1_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH2,  PH2_AVGFLT_POS | (PH2_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH3,  PH3_AVGFLT_POS | (PH3_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH4,  PH4_AVGFLT_POS | (PH4_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVG_PH0,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH1,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH2,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH3,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH4,  	0x00003F3F},\
}

#define REG_DOZE { \
    { CVT213X_REG_NUM,          REG_DOZE_NUM},\
    { CVT213X_FSM_IRQNEN,       DOZE_IRQ | (DOZE_CLOSEAND << 16) | (DOZE_FARAND << 24)},\
    { CVT213X_FSM_CTRL0,        DOZE_SCAN | (REF_PHASE << 16)},\
    { CVT213X_FSM_CTRL1,        DOZE_COMPEN | (DOZE_PHEN << 16) | (REF_EN << 26)},\
}

#elif (CVT213X_IC_TYPE_SELECT & IC_TYPE_CVT2138) 

#define CVT213X_REG_NUM         0x0000
#define REG_DEFAULT_NUM         0x0000002E
#define REG_INIT_NUM            0x00000011
#define REG_DOZE_NUM            0x00000004
#define REG_HOST_SLEEP_NUM      0x0000000C
#define REG_HOST_WAKEUP_NUM     0x0000000C

#define REG_DEFAULT { \
    { CVT213X_REG_NUM,          REG_DEFAULT_NUM},\
    { CVT213X_AFEC_CTRL0_PH0,   PH0_SCIO0_SEL | (PH0_SCIO1_SEL << 3) | (PH0_SCIO2_SEL << 6) | (PH0_SCIO3_SEL << 9) | (PH0_SCIO4_SEL << 12) | (PH0_SCIO5_SEL << 15) | (PH0_SCIO6_SEL << 18) | (PH0_SCIO7_SEL << 21)},\
    { CVT213X_AFEC_CTRL0_PH1,   PH1_SCIO0_SEL | (PH1_SCIO1_SEL << 3) | (PH1_SCIO2_SEL << 6) | (PH1_SCIO3_SEL << 9) | (PH1_SCIO4_SEL << 12) | (PH1_SCIO5_SEL << 15) | (PH1_SCIO6_SEL << 18) | (PH1_SCIO7_SEL << 21)},\
    { CVT213X_AFEC_CTRL0_PH2,   PH2_SCIO0_SEL | (PH2_SCIO1_SEL << 3) | (PH2_SCIO2_SEL << 6) | (PH2_SCIO3_SEL << 9) | (PH2_SCIO4_SEL << 12) | (PH2_SCIO5_SEL << 15) | (PH2_SCIO6_SEL << 18) | (PH2_SCIO7_SEL << 21)},\
    { CVT213X_AFEC_CTRL0_PH3,   PH3_SCIO0_SEL | (PH3_SCIO1_SEL << 3) | (PH3_SCIO2_SEL << 6) | (PH3_SCIO3_SEL << 9) | (PH3_SCIO4_SEL << 12) | (PH3_SCIO5_SEL << 15) | (PH3_SCIO6_SEL << 18) | (PH3_SCIO7_SEL << 21)},\
    { CVT213X_AFEC_CTRL0_PH4,   PH4_SCIO0_SEL | (PH4_SCIO1_SEL << 3) | (PH4_SCIO2_SEL << 6) | (PH4_SCIO3_SEL << 9) | (PH4_SCIO4_SEL << 12) | (PH4_SCIO5_SEL << 15) | (PH4_SCIO6_SEL << 18) | (PH4_SCIO7_SEL << 21)},\
    { CVT213X_AFEC_CTRL0_PH5,   PH5_SCIO0_SEL | (PH5_SCIO1_SEL << 3) | (PH5_SCIO2_SEL << 6) | (PH5_SCIO3_SEL << 9) | (PH5_SCIO4_SEL << 12) | (PH5_SCIO5_SEL << 15) | (PH5_SCIO6_SEL << 18) | (PH5_SCIO7_SEL << 21)},\
    { CVT213X_AFEC_CTRL0_PH6,   PH6_SCIO0_SEL | (PH6_SCIO1_SEL << 3) | (PH6_SCIO2_SEL << 6) | (PH6_SCIO3_SEL << 9) | (PH6_SCIO4_SEL << 12) | (PH6_SCIO5_SEL << 15) | (PH6_SCIO6_SEL << 18) | (PH6_SCIO7_SEL << 21)},\
    { CVT213X_AFEC_CTRL0_PH7,   PH7_SCIO0_SEL | (PH7_SCIO1_SEL << 3) | (PH7_SCIO2_SEL << 6) | (PH7_SCIO3_SEL << 9) | (PH7_SCIO4_SEL << 12) | (PH7_SCIO5_SEL << 15) | (PH7_SCIO6_SEL << 18) | (PH7_SCIO7_SEL << 21)},\
    { CVT213X_AFEC_CTRL1_PH0,   0x03035040 | PH0_FREQUENCY | (PH0_RESOLUTION << 8) | (PH0_SHD_EN << 11) | (PH0_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH1,   0x03035040 | PH1_FREQUENCY | (PH1_RESOLUTION << 8) | (PH1_SHD_EN << 11) | (PH1_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH2,   0x03035040 | PH2_FREQUENCY | (PH2_RESOLUTION << 8) | (PH2_SHD_EN << 11) | (PH2_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH3,   0x03035040 | PH3_FREQUENCY | (PH3_RESOLUTION << 8) | (PH3_SHD_EN << 11) | (PH3_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH4,   0x03035040 | PH4_FREQUENCY | (PH4_RESOLUTION << 8) | (PH4_SHD_EN << 11) | (PH4_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH5,   0x03035040 | PH5_FREQUENCY | (PH5_RESOLUTION << 8) | (PH5_SHD_EN << 11) | (PH5_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH6,   0x03035040 | PH6_FREQUENCY | (PH6_RESOLUTION << 8) | (PH6_SHD_EN << 11) | (PH6_CF_SEL << 28)},\
    { CVT213X_AFEC_CTRL1_PH7,   0x03035040 | PH7_FREQUENCY | (PH7_RESOLUTION << 8) | (PH7_SHD_EN << 11) | (PH7_CF_SEL << 28)},\
    { CVT213X_PROC_RAWFLT_PH0,  (PH0_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH1,  (PH1_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH2,  (PH2_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH3,  (PH3_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH4,  (PH4_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH5,  (PH5_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH6,  (PH6_RAWFLT << 8)},\
    { CVT213X_PROC_RAWFLT_PH7,  (PH7_RAWFLT << 8)},\
    { CVT213X_PROC_DIFF_PH0,    PH0_THRE | (PH0_FACT << 8) | (PH0_CLOSEDEB << 16) | (PH0_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH1,    PH1_THRE | (PH1_FACT << 8) | (PH1_CLOSEDEB << 16) | (PH1_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH2,    PH2_THRE | (PH2_FACT << 8) | (PH2_CLOSEDEB << 16) | (PH2_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH3,    PH3_THRE | (PH3_FACT << 8) | (PH3_CLOSEDEB << 16) | (PH3_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH4,    PH4_THRE | (PH4_FACT << 8) | (PH4_CLOSEDEB << 16) | (PH4_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH5,    PH5_THRE | (PH5_FACT << 8) | (PH5_CLOSEDEB << 16) | (PH5_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH6,    PH6_THRE | (PH6_FACT << 8) | (PH6_CLOSEDEB << 16) | (PH6_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH7,    PH7_THRE | (PH7_FACT << 8) | (PH7_CLOSEDEB << 16) | (PH7_FARDEB << 18)},\
    { CVT213X_FSM_IRQNEN,       DEFAULT_IRQ | (DEFAULT_CLOSEAND << 16) | (DEFAULT_FARAND << 24)},\
    { CVT213X_FSM_CTRL0,        DEFAULT_SCAN | (REF_PHASE << 16)},\
    { CVT213X_FSM_CTRL1,        DEFAULT_COMPEN | (DEFAULT_PHEN << 16) | (REF_EN << 26)},\
    { CVT213X_PROC_COR_PH0,     PH0_REFSRC | (PH0_COR_EN << 16) | (PH0_COEF << 24)},\
    { CVT213X_PROC_COR_PH1,     PH1_REFSRC | (PH1_COR_EN << 16) | (PH1_COEF << 24)},\
    { CVT213X_PROC_COR_PH2,     PH2_REFSRC | (PH2_COR_EN << 16) | (PH2_COEF << 24)},\
    { CVT213X_PROC_COR_PH3,     PH3_REFSRC | (PH3_COR_EN << 16) | (PH3_COEF << 24)},\
    { CVT213X_PROC_COR_PH4,     PH4_REFSRC | (PH4_COR_EN << 16) | (PH4_COEF << 24)},\
    { CVT213X_PROC_COR_PH5,     PH5_REFSRC | (PH5_COR_EN << 16) | (PH5_COEF << 24)},\
    { CVT213X_PROC_COR_PH6,     PH6_REFSRC | (PH6_COR_EN << 16) | (PH6_COEF << 24)},\
    { CVT213X_PROC_COR_PH7,     PH7_REFSRC | (PH7_COR_EN << 16) | (PH7_COEF << 24)},\
    { CVT213X_PROC_AVGFLT_PH1,  0x07U | (0x07U << 4)},\
    { CVT213X_PROC_AVGFLT_PH2,  0x07U | (0x07U << 4)},\
}

#define REG_INIT { \
    { CVT213X_REG_NUM,          REG_INIT_NUM},\
    { CVT213X_PROC_AVGFLT_PH0,  PH0_AVGFLT_POS | (PH0_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH1,  PH1_AVGFLT_POS | (PH1_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH2,  PH2_AVGFLT_POS | (PH2_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH3,  PH3_AVGFLT_POS | (PH3_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH4,  PH4_AVGFLT_POS | (PH4_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH5,  PH5_AVGFLT_POS | (PH5_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH6,  PH6_AVGFLT_POS | (PH6_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVGFLT_PH7,  PH7_AVGFLT_POS | (PH7_AVGFLT_NEG << 4)},\
    { CVT213X_PROC_AVG_PH0,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH1,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH2,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH3,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH4,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH5,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH6,  	0x00003F3F},\
	{ CVT213X_PROC_AVG_PH7,  	0x00003F3F},\
}

#define REG_DOZE { \
    { CVT213X_REG_NUM,          REG_DOZE_NUM},\
    { CVT213X_FSM_IRQNEN,       DOZE_IRQ | (DOZE_CLOSEAND << 16) | (DOZE_FARAND << 24)},\
    { CVT213X_FSM_CTRL0,        DOZE_SCAN | (REF_PHASE << 16)},\
    { CVT213X_FSM_CTRL1,        DOZE_COMPEN | (DOZE_PHEN << 16) | (REF_EN << 26)},\
}
#endif

#if 0
#define REG_HOST_SLEEP { \
    { CVT213X_REG_NUM,          REG_HOST_SLEEP_NUM},\
    { CVT213X_PROC_DIFF_PH0,    PH0_THRE | (PH0_FACT << 8) | (PH0_CLOSEDEB_HOST_SLEEP << 16) | (PH0_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH1,    PH1_THRE | (PH1_FACT << 8) | (PH1_CLOSEDEB_HOST_SLEEP << 16) | (PH1_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH2,    PH2_THRE | (PH2_FACT << 8) | (PH2_CLOSEDEB_HOST_SLEEP << 16) | (PH2_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH3,    PH3_THRE | (PH3_FACT << 8) | (PH3_CLOSEDEB_HOST_SLEEP << 16) | (PH3_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH4,    PH4_THRE | (PH4_FACT << 8) | (PH4_CLOSEDEB_HOST_SLEEP << 16) | (PH4_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH5,    PH5_THRE | (PH5_FACT << 8) | (PH5_CLOSEDEB_HOST_SLEEP << 16) | (PH5_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH6,    PH6_THRE | (PH6_FACT << 8) | (PH6_CLOSEDEB_HOST_SLEEP << 16) | (PH6_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH7,    PH7_THRE | (PH7_FACT << 8) | (PH7_CLOSEDEB_HOST_SLEEP << 16) | (PH7_FARDEB << 18)},\
    { CVT213X_FSM_IRQNEN,       HOST_SLEEP_IRQ | (HOST_SLEEP_CLOSEAND << 16) | (HOST_SLEEP_FARAND << 24)},\
    { CVT213X_FSM_CTRL0,        HOST_SLEEP_SCAN | (REF_PHASE << 16)},\
    { CVT213X_FSM_CTRL1,        HOST_SLEEP_COMPEN | (HOST_SLEEP_PHEN << 16) | (REF_EN << 26)},\
}
#else       //fix long press poweroff earhone then poweron soon
#define REG_HOST_SLEEP { \
    { CVT213X_REG_NUM,          REG_HOST_SLEEP_NUM},\
    { CVT213X_PROC_DIFF_PH0,    PH0_THRE | (PH0_FACT << 8) | (PH0_CLOSEDEB_HOST_SLEEP << 16) | (PH0_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH1,    PH1_THRE | (PH1_FACT << 8) | (PH1_CLOSEDEB_HOST_SLEEP << 16) | (PH1_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH2,    PH2_THRE | (PH2_FACT << 8) | (PH2_CLOSEDEB_HOST_SLEEP << 16) | (PH2_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH3,    PH3_THRE | (PH3_FACT << 8) | (PH3_CLOSEDEB_HOST_SLEEP << 16) | (PH3_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH4,    PH4_THRE | (PH4_FACT << 8) | (PH4_CLOSEDEB_HOST_SLEEP << 16) | (PH4_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH5,    PH5_THRE | (PH5_FACT << 8) | (PH5_CLOSEDEB_HOST_SLEEP << 16) | (PH5_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH6,    PH6_THRE | (PH6_FACT << 8) | (PH6_CLOSEDEB_HOST_SLEEP << 16) | (PH6_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH7,    PH7_THRE | (PH7_FACT << 8) | (PH7_CLOSEDEB_HOST_SLEEP << 16) | (PH7_FARDEB << 18)},\
    { CVT213X_FSM_IRQNEN,       HOST_SLEEP_IRQ | (HOST_SLEEP_CLOSEAND << 16) | (HOST_SLEEP_FARAND << 24)},\
    { CVT213X_FSM_CTRL0,        DOZE_SCAN | (REF_PHASE << 16)},\
    { CVT213X_FSM_CTRL1,        HOST_SLEEP_COMPEN | (HOST_SLEEP_PHEN << 16) | (REF_EN << 26)},\
}
#endif

#define REG_HOST_WAKEUP { \
    { CVT213X_REG_NUM,          REG_HOST_WAKEUP_NUM},\
    { CVT213X_PROC_DIFF_PH0,    PH0_THRE | (PH0_FACT << 8) | (PH0_CLOSEDEB << 16) | (PH0_FARDEB << 18) },\
    { CVT213X_PROC_DIFF_PH1,    PH1_THRE | (PH1_FACT << 8) | (PH1_CLOSEDEB << 16) | (PH1_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH2,    PH2_THRE | (PH2_FACT << 8) | (PH2_CLOSEDEB << 16) | (PH2_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH3,    PH3_THRE | (PH3_FACT << 8) | (PH3_CLOSEDEB << 16) | (PH3_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH4,    PH4_THRE | (PH4_FACT << 8) | (PH4_CLOSEDEB << 16) | (PH4_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH5,    PH5_THRE | (PH5_FACT << 8) | (PH5_CLOSEDEB << 16) | (PH5_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH6,    PH6_THRE | (PH6_FACT << 8) | (PH6_CLOSEDEB << 16) | (PH6_FARDEB << 18)},\
    { CVT213X_PROC_DIFF_PH7,    PH7_THRE | (PH7_FACT << 8) | (PH7_CLOSEDEB << 16) | (PH7_FARDEB << 18)},\
    { CVT213X_FSM_IRQNEN,       DOZE_IRQ | (DOZE_CLOSEAND << 16) | (DOZE_FARAND << 24)},\
    { CVT213X_FSM_CTRL0,        DOZE_SCAN | (REF_PHASE << 16)},\
    { CVT213X_FSM_CTRL1,        DOZE_COMPEN | (DOZE_PHEN << 16) | (REF_EN << 26)},\
}

//开始时等待信号稳定，进行抛帧
#define  TIMEOUT_CYCLE          1

/************************************不可修改常量**********************************/
#define GESTURE_VAR_VAL { \
    LONG_PRESS_THRE, \
    LONG_PRESS_REPEAT_EN, \
    LONG_PRESS_REPEAT_THRE, \
    DOUBLE_CLICK_THRE, \
    PUSH_THRE, \
    RELESE_THRE, \
    SLIDE_THRE, \
    SLIDE_REPEAT_EN, \
    SLIDE_REPEAT_THR, \
    CLICK_NUM_EN, \
    CLICK_AND_LONG_PRESS_EN, \
    CLICK_AND_LONG_PRESS_THRE, \
}

/*************************************Logger***********************************/
//APP log
#if CVT213X_APP_LOG_EN
    #define CVT213X_APP_LOG_TAG "[CVA_APP_LOG]"

    #define CVT213X_APP_LOG_D(arg_cnt,...)                          \
        do {                                                        \
            if(g_cvt213x_app_level<=LOG_LEVEL_DBG){                 \
                LOG_INF(CVT213X_APP_LOG_TAG __VA_ARGS__);           \
            }                                                       \
        } while(0)                                                  \

    #define CVT213X_APP_LOG_W(arg_cnt,...)                          \
        do {                                                        \
            if(g_cvt213x_app_level<=LOG_LEVEL_WRO){                 \
                LOG_INF(CVT213X_APP_LOG_TAG __VA_ARGS__);           \
            }                                                       \
        } while(0)

    #define CVT213X_APP_LOG_E(arg_cnt,...)                          \
        do {                                                        \
            if(g_cvt213x_app_level<=LOG_LEVEL_ERR){                 \
                LOG_INF(CVT213X_APP_LOG_TAG __VA_ARGS__);           \
            }                                                       \
        } while(0)
#else
    #define CVT213X_APP_LOG_D(arg_cnt,...)
    #define CVT213X_APP_LOG_W(arg_cnt,...)
    #define CVT213X_APP_LOG_E(arg_cnt,...)
#endif

//LIB log
#if CVT213X_LIB_LOG_EN
    #define CVT213X_LIB_LOG_TAG "[CVA_LIB_LOG]"

    #define CVT213X_LIB_LOG_D(arg_cnt,...)                          \
        do {                                                        \
            if(g_cvt213x_lib_level<=LOG_LEVEL_DBG){                 \
                 LOG_INF(CVT213X_LIB_LOG_TAG __VA_ARGS__);          \
            }                                                       \
        } while(0)

    #define CVT213X_LIB_LOG_W(arg_cnt,...)                          \
        do {                                                        \
            if(g_cvt213x_lib_level<=LOG_LEVEL_WRO){                 \
                LOG_INF(CVT213X_LIB_LOG_TAG __VA_ARGS__);           \
            }                                                       \
        } while(0)                                                  \

    #define CVT213X_LIB_LOG_E(arg_cnt,...)                          \
        do {                                                        \
            if(g_cvt213x_lib_level<=LOG_LEVEL_ERR){                 \
                LOG_INF(CVT213X_LIB_LOG_TAG __VA_ARGS__);           \
            }                                                       \
        } while(0)
#else
    #define CVT213X_LIB_LOG_D(arg_cnt,...)
    #define CVT213X_LIB_LOG_W(arg_cnt,...)
    #define CVT213X_LIB_LOG_E(arg_cnt,...)
#endif

//Tx/Rx log
#if CVT213X_TRX_LOG_EN
    #define CVT213X_TRX_LOG_TAG "[CVA_TRX_LOG]"

    #define CVT213X_TRX_LOG_D(arg_cnt,...)                          \
        do {                                                        \
            if(g_cvt213x_trx_level<=LOG_LEVEL_DBG){                 \
                LOG_INF(CVT213X_TRX_LOG_TAG __VA_ARGS__);           \
            }                                                       \
        } while(0)                                                  \

    #define CVT213X_TRX_LOG_W(arg_cnt,...)                          \
        do {                                                        \
            if(g_cvt213x_trx_level<=LOG_LEVEL_WRO){                 \
                LOG_INF(CVT213X_TRX_LOG_TAG __VA_ARGS__);           \
            }                                                       \
        } while(0)

    #define CVT213X_TRX_LOG_E(arg_cnt,...)                          \
        do {                                                        \
            if(g_cvt213x_trx_level<=LOG_LEVEL_ERR){                 \
                LOG_INF(CVT213X_TRX_LOG_TAG __VA_ARGS__);           \
            }                                                       \
        } while(0)
#else
    #define CVT213X_TRX_LOG_D(arg_cnt,...)
    #define CVT213X_TRX_LOG_W(arg_cnt,...)
    #define CVT213X_TRX_LOG_E(arg_cnt,...)
#endif

/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/
typedef enum
{
    DEFAULT_MODE = 0x00,
    INIT_MODE,
    DOZE_MODE,
    ACTIVE_MODE,
    NULL_MODE,
    HOST_SLEEP_MODE,
    HOST_WAKEUP_MODE,
} enum_scan_mode;

/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/
#if DUAL_CVT213X_ENABLE
#define IS_1ST_IED_ENABLE (FUNC_TYPE & (FUNC_DOU_IED | FUNC_SIG_IED))
#define IS_2ND_IED_ENABLE (FUNC_TYPE_2ND & (FUNC_DOU_IED | FUNC_SIG_IED))
#define IS_IED_ENABLE  (IS_1ST_IED_ENABLE | IS_2ND_IED_ENABLE)
#define IS_IED_SIG_IED ((FUNC_TYPE & FUNC_SIG_IED) | (FUNC_TYPE_2ND & FUNC_SIG_IED))
#define IS_IED_DOU_IED ((FUNC_TYPE & FUNC_DOU_IED) | (FUNC_TYPE_2ND & FUNC_DOU_IED))

#define IS_1ST_TK_ENABLE (FUNC_TYPE & (FUNC_TOUCH_ENABLE | FUNC_SLIDE_ENABLE))
#define IS_2ND_TK_ENABLE (FUNC_TYPE_2ND & (FUNC_TOUCH_ENABLE | FUNC_SLIDE_ENABLE))
#define IS_TK_ENABLE   (IS_1ST_TK_ENABLE | IS_2ND_TK_ENABLE)
#define IS_TK_TOUCH_ENABLE   ((FUNC_TYPE & FUNC_TOUCH_ENABLE) | (FUNC_TYPE_2ND & FUNC_TOUCH_ENABLE))
#define IS_TK_SLIDE_ENABLE   ((FUNC_TYPE & (FUNC_SLIDE_ENABLE)) | (FUNC_TYPE_2ND & (FUNC_SLIDE_ENABLE)))
#else
#define IS_IED_ENABLE (FUNC_TYPE & (FUNC_DOU_IED | FUNC_SIG_IED))
#define IS_IED_SIG_IED (FUNC_TYPE & FUNC_SIG_IED)
#define IS_IED_DOU_IED (FUNC_TYPE & FUNC_DOU_IED)

#define IS_TK_ENABLE (FUNC_TYPE & (FUNC_TOUCH_ENABLE | FUNC_SLIDE_ENABLE))
#define IS_TK_TOUCH_ENABLE   (FUNC_TYPE & FUNC_TOUCH_ENABLE)
#define IS_TK_SLIDE_ENABLE   (FUNC_TYPE & (FUNC_SLIDE_ENABLE))
#endif
/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/

#ifdef __cplusplus
}
#endif

#endif

