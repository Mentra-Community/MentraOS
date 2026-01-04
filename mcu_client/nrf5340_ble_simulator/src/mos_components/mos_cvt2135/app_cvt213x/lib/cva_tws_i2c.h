/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_i2c.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

#ifndef _CVA_TWS_I2C_H_
#define _CVA_TWS_I2C_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
* 1.Included files
*******************************************************************************/

/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/
//fsm_reg base address 0x0000
#define      FSM_IRQ                0x0000
#define      FSM_IRQNEN             0x0004
#define      FSM_STAT0              0x0008
#define      FSM_STAT1              0x000C
#define      FSM_STAT2              0x0010
#define      FSM_I2C_ADDR           0x0014
#define      FSM_CMD                0x0020
#define      FSM_CTRL0              0x0028
#define      FSM_CTRL1              0x002c
#define      FSM_TMEP               0x0030
#define      FSM_DBG                0x0034

//afec_reg base address 0x2000
#define      AFEC_CTR0              0x2000
#define      AFEC_ADC_TEST          0x2004

#define      AFEC_PH0_CTRL0         0x2100
#define      AFEC_PH0_CTRL1         0x2104
#define      AFEC_PH0_CTRL2         0x2108
#define      AFEC_PH0_CTRL3         0x210C

#define      AFEC_PH1_CTRL0         0x2110
#define      AFEC_PH1_CTRL1         0x2114
#define      AFEC_PH1_CTRL2         0x2118
#define      AFEC_PH1_CTRL3         0x211C

#define      AFEC_PH2_CTRL0         0x2120
#define      AFEC_PH2_CTRL1         0x2124
#define      AFEC_PH2_CTRL2         0x2128
#define      AFEC_PH2_CTRL3         0x212C

#define      AFEC_PH3_CTRL0         0x2130
#define      AFEC_PH3_CTRL1         0x2134
#define      AFEC_PH3_CTRL2         0x2138
#define      AFEC_PH3_CTRL3         0x213C

#define      AFEC_PH4_CTRL0         0x2140
#define      AFEC_PH4_CTRL1         0x2144
#define      AFEC_PH4_CTRL2         0x2148
#define      AFEC_PH4_CTRL3         0x214C

#define      AFEC_PH5_CTRL0         0x2150
#define      AFEC_PH5_CTRL1         0x2154
#define      AFEC_PH5_CTRL2         0x2158
#define      AFEC_PH5_CTRL3         0x215C

#define      AFEC_PH6_CTRL0         0x2160
#define      AFEC_PH6_CTRL1         0x2164
#define      AFEC_PH6_CTRL2         0x2168
#define      AFEC_PH6_CTRL3         0x216C

#define      AFEC_PH7_CTRL0         0x2170
#define      AFEC_PH7_CTRL1         0x2174
#define      AFEC_PH7_CTRL2         0x2178
#define      AFEC_PH7_CTRL3         0x217C

#define      AFEC_PH8_CTRL0         0x2180
#define      AFEC_PH8_CTRL3         0x2188

#define      AFEC_PH_STATUS         0x2200
#define      AFEC_ADC_DAT           0x2204
#define      AFEC_MPX               0x2300

//proc_reg base address 0x3000
#define      PROC_RAWFLT            0x3000
#define      PROC_AVGFLT            0x3004
#define      PROC_AVG               0x3008
#define      PROC_STUP0             0x300c
#define      PROC_STUP1             0x3010
#define      PROC_DIFF              0x3014
#define      PROC_STEADY            0x3020
#define      PROC_FAIL              0x3024
#define      PROC_COMP              0x3028
#define      PROC_COR               0x302c
#define      PROC_RDAT0             0x3030
#define      PROC_RDAT1             0x3034
#define      PROC_RDAT2             0x3038

#define      PROC_RAWFLT_PH1            0x3100
#define      PROC_AVGFLT_PH1            0x3104
#define      PROC_AVG_PH1               0x3108
#define      PROC_STUP0_PH1             0x310c
#define      PROC_STUP1_PH1             0x3110
#define      PROC_DIFF_PH1              0x3114
#define      PROC_STEADY_PH1            0x3120
#define      PROC_FAIL_PH1              0x3124
#define      PROC_COMP_PH1              0x3128
#define      PROC_COR_PH1               0x312c
#define      PROC_RDAT0_PH1             0x3130
#define      PROC_RDAT1_PH1             0x3134
#define      PROC_RDAT2_PH1             0x3138

#define      PROC_RAWFLT_PH2            0x3200
#define      PROC_AVGFLT_PH2            0x3204
#define      PROC_AVG_PH2               0x3208
#define      PROC_STUP0_PH2             0x320c
#define      PROC_STUP1_PH2             0x3210
#define      PROC_DIFF_PH2              0x3214
#define      PROC_STEADY_PH2            0x3220
#define      PROC_FAIL_PH2              0x3224
#define      PROC_COMP_PH2              0x3228
#define      PROC_COR_PH2               0x322c
#define      PROC_RDAT0_PH2             0x3230
#define      PROC_RDAT1_PH2             0x3234
#define      PROC_RDAT2_PH2             0x3238

#define      PROC_RAWFLT_PH3            0x3300
#define      PROC_AVGFLT_PH3            0x3304
#define      PROC_AVG_PH3               0x3308
#define      PROC_STUP0_PH3             0x330c
#define      PROC_STUP1_PH3             0x3310
#define      PROC_DIFF_PH3              0x3314
#define      PROC_STEADY_PH3            0x3320
#define      PROC_FAIL_PH3              0x3324
#define      PROC_COMP_PH3              0x3328
#define      PROC_COR_PH3               0x332c
#define      PROC_RDAT0_PH3             0x3330
#define      PROC_RDAT1_PH3             0x3334
#define      PROC_RDAT2_PH3             0x3338

#define      PROC_RAWFLT_PH4            0x3400
#define      PROC_AVGFLT_PH4            0x3404
#define      PROC_AVG_PH4               0x3408
#define      PROC_STUP0_PH4             0x340c
#define      PROC_STUP1_PH4             0x3410
#define      PROC_DIFF_PH4              0x3414
#define      PROC_STEADY_PH4            0x3420
#define      PROC_FAIL_PH4              0x3424
#define      PROC_COMP_PH4              0x3428
#define      PROC_COR_PH4               0x342c
#define      PROC_RDAT0_PH4             0x3430
#define      PROC_RDAT1_PH4             0x3434
#define      PROC_RDAT2_PH4             0x3438

#define      PROC_RAWFLT_PH5            0x3500
#define      PROC_AVGFLT_PH5            0x3504
#define      PROC_AVG_PH5               0x3508
#define      PROC_STUP0_PH5             0x350c
#define      PROC_STUP1_PH5             0x3510
#define      PROC_DIFF_PH5              0x3514
#define      PROC_STEADY_PH5            0x3520
#define      PROC_FAIL_PH5              0x3524
#define      PROC_COMP_PH5              0x3528
#define      PROC_COR_PH5               0x352c
#define      PROC_RDAT0_PH5             0x3530
#define      PROC_RDAT1_PH5             0x3534
#define      PROC_RDAT2_PH5             0x3538

#define      PROC_RAWFLT_PH6            0x3600
#define      PROC_AVGFLT_PH6            0x3604
#define      PROC_AVG_PH6               0x3608
#define      PROC_STUP0_PH6             0x360c
#define      PROC_STUP1_PH6             0x3610
#define      PROC_DIFF_PH6              0x3614
#define      PROC_STEADY_PH6            0x3620
#define      PROC_FAIL_PH6              0x3624
#define      PROC_COMP_PH6              0x3628
#define      PROC_COR_PH6               0x362c
#define      PROC_RDAT0_PH6             0x3630
#define      PROC_RDAT1_PH6             0x3634
#define      PROC_RDAT2_PH6             0x3638

#define      PROC_RAWFLT_PH7            0x3700
#define      PROC_AVGFLT_PH7            0x3704
#define      PROC_AVG_PH7               0x3708
#define      PROC_STUP0_PH7             0x370c
#define      PROC_STUP1_PH7             0x3710
#define      PROC_DIFF_PH7              0x3714
#define      PROC_STEADY_PH7            0x3720
#define      PROC_FAIL_PH7              0x3724
#define      PROC_COMP_PH7              0x3728
#define      PROC_COR_PH7               0x372c
#define      PROC_RDAT0_PH7             0x3730
#define      PROC_RDAT1_PH7             0x3734
#define      PROC_RDAT2_PH7             0x3738

#define      PROC_RAWFLT_PH8            0x3800
#define      PROC_AVGFLT_PH8            0x3804
#define      PROC_AVG_PH8               0x3808
#define      PROC_STUP0_PH8             0x380c
#define      PROC_STUP1_PH8             0x3810
#define      PROC_DIFF_PH8              0x3814
#define      PROC_STEADY_PH8            0x3820
#define      PROC_FAIL_PH8              0x3824
#define      PROC_COMP_PH8              0x3828
#define      PROC_COR_PH8               0x382c
#define      PROC_RDAT0_PH8             0x3830
#define      PROC_RDAT1_PH8             0x3834
#define      PROC_RDAT2_PH8             0x3838

//crgu_reg base address 0x4000
#define      IP_CLK_EN              0x4000
#define      IP_SW_RST              0x4004
#define      CHIP_RESET             0x4008
#define      RESET_FLAG             0x400c

//io_reg  base address  0x5000
#define      GPIO_CTRL0             0x5000
#define      GPIO_CTRL1             0x5004
#define      PAD_CSIO_CTRL0         0x5008
#define      PAD_CSIO_CTRL1         0x500C
#define      PAD_NIRQ_CTRL0         0x5010

//efuse_reg base address 0x6000
#define      PMU_TRIM0              0x6000
#define      PMU_TRIM1              0x6004
#define      PMU_TREG               0x6008

#define TWS_SET_BITS(X) (TWS_U32)(1 << X)

#define TWS_IRQ_READY       TWS_SET_BITS(0)
#define TWS_IRQ_CLOSE       TWS_SET_BITS(1)
#define TWS_IRQ_FAR         TWS_SET_BITS(2)
#define TWS_IRQ_COMPDONE    TWS_SET_BITS(3)
#define TWS_IRQ_CONVDONE    TWS_SET_BITS(4)
#define TWS_IRQ_PROG0       TWS_SET_BITS(5)
#define TWS_IRQ_PROG1       TWS_SET_BITS(6)
#define TWS_IRQ_PROG2       TWS_SET_BITS(7)
#define TWS_IRQ_CLOSEAND    TWS_SET_BITS(0)
#define TWS_IRQ_FARAND      TWS_SET_BITS(1)

//Phase status
#define TWS_STAT_PH0        TWS_SET_BITS(0)
#define TWS_STAT_PH1        TWS_SET_BITS(1)
#define TWS_STAT_PH2        TWS_SET_BITS(2)
#define TWS_STAT_PH3        TWS_SET_BITS(3)
#define TWS_STAT_PH4        TWS_SET_BITS(4)
#define TWS_STAT_PH5        TWS_SET_BITS(5)
#define TWS_STAT_PH6        TWS_SET_BITS(6)
#define TWS_STAT_PH7        TWS_SET_BITS(7)

/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/
typedef enum
{
    SCANING =  0x0,
    READY,
} enum_data_status_e;

/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/

/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/
void  cvt213x_i2c_read_irq(tws_chip_index_e chipIndex, TWS_U8 *rd_data);
void  cvt213x_i2c_load_reg(tws_chip_index_e chipIndex, const enum_scan_mode mode);

tws_ret_e cvt213x_i2c_reset(tws_chip_index_e chipIndex);
void cvt213x_i2c_mp_init(tws_chip_index_e chipIndex);

#ifdef __cplusplus
}
#endif

#endif

