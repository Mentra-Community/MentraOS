/*******************************************************************************
* Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
*
* File:         cva_tws_dongle.h
* Description:  
* Version：      V2.0
* Date：         2021-11-16
* Author：       CVA Software Team
 *******************************************************************************/

#ifndef _CVA_TWS_DONGLE_H_
#define _CVA_TWS_DONGLE_H_

#ifdef __cplusplus
extern "C" {
#endif

/*******************************************************************************
* 1.Included files
*******************************************************************************/

/*******************************************************************************
* 2.Global constant and macro definitions using #define
*******************************************************************************/
#define AFEC_ADR_OFFSET     0x0010
#define BASE_ADR_OFFSET     0x0100

#define SET_BIT(X)    (TWS_U32)(1 << X)
#define CLEAR_BIT(X)  (TWS_U32)(!(1 << X))

#define WAIT_IRQ_MODE_WRITE             255

/*******************************************************************************
* 3.Global structures, unions and enumerations using typedef
*******************************************************************************/
typedef enum
{
    TWS_MSG_TEST_MODE_STATUS = 0X00,
    TWS_MSG_R_CMDSTATE      = 0X01,

    TWS_MSG_I2C_READ        = 0X50,
    TWS_MSG_R_I2C_READ      = 0X51,
    TWS_MSG_I2C_WRITE       = 0X52,
    TWS_MSG_R_I2C_WRITE     = 0X53,
    TWS_MSG_GET_LOG         = 0X54,
    TWS_MSG_R_GET_LOG       = 0X55,
    TWS_MSG_GET_VERSION     = 0X56,
    TWS_MSG_R_GET_VERSION   = 0X57,
    TWS_MSG_HOST_CMD        = 0X58,
    TWS_MSG_SET_MODE        = 0X59,
    TWS_MSG_GET_EVENT       = 0X5C,
    TWS_MSG_R_GET_EVENT     = 0X5D,
    TWS_MSG_GET_BLUETOOTH_ADDR = 0X60,
    TWS_MSG_GET_R_BLUETOOTH_ADDR = 0X61,

    TWS_MSG_GET_DIFF        = 0X70,
    TWS_MSG_R_GET_DIFF      = 0X71,
    TWS_MSG_GET_RAW         = 0X72,
    TWS_MSG_R_GET_RAW       = 0X73,
    TWS_MSG_GET_AFEC        = 0X74,
    TWS_MSG_R_GET_AFEC      = 0X75,
    TWS_MSG_GET_CC          = 0X76,
    TWS_MSG_R_GET_CC        = 0X77,
    TWS_MSG_GET_PROC_DIFF   = 0X78,
    TWS_MSG_R_GET_PROC_DIFF = 0X79,
    TWS_MSG_GET_FLASH_CFG   = 0X7a,
    TWS_MSG_R_GET_FLASH_CFG = 0X7b,
    TWS_MSG_GET_DEBUG_DATA  = 0X7c,
    TWS_MSG_R_GET_DEBUG_DATA = 0X7d,
    TWS_MSG_SET_SETUP_INFO  = 0X7e,
    TWS_MSG_R_SET_SETUP_INFO = 0X7f,

    TWS_MSG_GET_FLASH_DATA  = 0X80,
    TWS_MSG_R_GET_FLASH_DATA = 0X81,
    TWS_MSG_GET_KEY_VAR_DATA  = 0X82,
    TWS_MSG_R_GET_KEY_VAR_DATA = 0X83,
    TWS_MSG_GET_PARAMETER_CONFIG  = 0X84,
    TWS_MSG_R_GET_PARAMETER_CONFIG = 0X85,
    TWS_MSG_SET_PARAMETER_CONFIG  = 0X86,
    TWS_MSG_R_SET_PARAMETER_CONFIG = 0X87,

    TWS_MSG_CLEAR_FLASH_THR = 0X90,
    TWS_MSG_R_CLEAR_FLASH_THR = 0X91,
} tws_msg_type_e;

typedef enum
{
    TRX_DATA_HEAD_ERROR  =  0x01,
    TRX_DATA_SIZE_ERROR  =  0x02,
    TRX_DATA_CHECK_ERROR =  0x03,
    TRX_DATA_CHECK_PASS  =  0x55,
} trx_check_status_e;

typedef enum
{
    AFEC_ADR_BASE       =  0x2104,  //offset 0x0010
    CC_ADR_BASE         =  0x3028,  //offset 0x0100
    PROC_ADR_BASE       =  0x3014,  //offset 0x0100
    RAW_ADR_BASE        =  0x3030,  //offset 0x0100
    DIFF_ADR_BASE       =  0x3038,  //offset 0x0100
} adr_base_e;

typedef enum
{
    TRX_TEST_MODE_EN        =  0, 
    TRX_TEST_MODE_DIS       =  1, 
    TRX_SHOW_MODE_EN        =  2, 
    TRX_SHOW_MODE_DIS       =  3, 
} trx_test_mode_e;

typedef enum
{
    TRX_Handle_BUSY         =  SET_BIT(0),
    TRX_Handle_FINISH       =  CLEAR_BIT(0),
    TRX_IRQ_BUSY            =  SET_BIT(1),
    TRX_IRQ_FINISH          =  CLEAR_BIT(1),
    TRX_ALL_FINISH          =  0,
} trx_hanlde_state_e;

typedef enum
{
    SETUP_CMD_MP_WRITE     =0x00,       //MP write setup info
    SETUP_CMD_APP_WRITE    =0x01,       //APP write setup info
    SETUP_CMD_READ         =0x02,       //read setup info
    SETUP_CMD_CLEAR        =0x03,       //clear setup info
    SETUP_CMD_END          =0x0F,       //clear setup info
}setup_cmd_e;

/*******************************************************************************
* 4.Global variable extern declarations
*******************************************************************************/

/*******************************************************************************
* 5.Global function prototypes
*******************************************************************************/
void cvt213x_dongle_clear_event(void);
TWS_U8 cvt213x_get_test_mode_status(void);

void cvt213x_set_enter_mp_mode_flag(TWS_BOOL mode);
TWS_U8 cvt213x_get_cmd_mode_status(void);

#ifdef __cplusplus
}
#endif

#endif

