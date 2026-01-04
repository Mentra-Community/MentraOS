/*******************************************************************************
 * Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
 *
 * File:         app_cvt213x_porting.h
 * Description:
 * Version：      V2.0
 * Date：         2021-11-16
 * Author：       CVA Software Team
 *******************************************************************************/

#ifndef __APP_CVT213X_PORTING_H__
#define __APP_CVT213X_PORTING_H__

#ifdef __cplusplus
extern "C"
{
#endif

/*******************************************************************************
 * 1.Included files
 *******************************************************************************/
#include "./lib/api/cva_tws_config.h"

/*******************************************************************************
 * 2.Global constant and macro definitions using #define
 *******************************************************************************/
// porting TODO: typedef data type
#include <stdint.h>
    typedef int8_t   TWS_BOOL;
    typedef uint8_t  TWS_U8;
    typedef int8_t   TWS_S8;
    typedef uint16_t TWS_U16;
    typedef int16_t  TWS_S16;
    typedef uint32_t TWS_U32;
    typedef int32_t  TWS_S32;

    /* Common short-width aliases used elsewhere in the codebase */
    typedef uint8_t  u8;
    typedef uint16_t u16;
    typedef uint32_t u32;

/********************************Logger config********************************/
// log interface
#if FEATURE_DEBUG_LOG
// porting TODO: host platform logging interface
#include <stdio.h>
#define CVT213X_PRINT(...) \
    printf(__VA_ARGS__); \
    printf("\n");
#else
#define CVT213X_PRINT(...)
#endif

/******************************I2C device address******************************/
#if DUAL_CVT213X_ENABLE

#define CVT213X_I2C_7BITS_ADDRESS_W (0x28)
#define CVT213X_I2C_8BITS_ADDRESS_W (CVT213X_I2C_7BITS_ADDRESS_W << 1)
#define CVT213X_I2C_8BITS_ADDRESS_R (CVT213X_I2C_8BITS_ADDRESS_W | 0x01)

#define CVT213X_I2C_2ND_7BITS_ADDRESS_W (0x2C)
#define CVT213X_I2C_2ND_8BITS_ADDRESS_W (CVT213X_I2C_2ND_7BITS_ADDRESS_W << 1)
#define CVT213X_I2C_2ND_8BITS_ADDRESS_R (CVT213X_I2C_2ND_8BITS_ADDRESS_W | 0x01)

#else

#define CVT213X_I2C_7BITS_ADDRESS_W (0x28)
#define CVT213X_I2C_8BITS_ADDRESS_W (CVT213X_I2C_7BITS_ADDRESS_W << 1)
#define CVT213X_I2C_8BITS_ADDRESS_R (CVT213X_I2C_8BITS_ADDRESS_W | 0x01)

#endif

    /*******************************************************************************
     * 3.Global structures, unions and enumerations using typedef
     *******************************************************************************/
    // porting TODO: host platform thread event
    typedef enum EARBUD_CVT213X
    {
        APP_MODUAL_CVT213X_IRQ       = 0x7c0,
        APP_MODUAL_CVT213X_TRX_START = 0x7c9,
        APP_MODUAL_CVT213X_TRX_END   = 0x7c8,
        APP_MODUAL_CVT213X_TRX_DATA  = 0x7c7,
#if DUAL_CVT213X_ENABLE
        APP_MODUAL_CVT213X_IRQ_2ND = 0x7c1,
#endif
    } EARBUD_CVT213X_ID;

    /*******************************************************************************
     * 4.Global variable extern declarations
     *******************************************************************************/
    extern TWS_U16 g_cvt213x_tick_cnt;
    extern TWS_U16 g_cvt213x_polling_flag;
    extern TWS_U16 g_cvt213x_irq_flag;

    extern TWS_U8 g_cvt213x_app_level;
    extern TWS_U8 g_cvt213x_lib_level;
    extern TWS_U8 g_cvt213x_trx_level;
    /*******************************************************************************
     * 5.Global function prototypes
     *******************************************************************************/
    void cvt213x_cmd_read_bluetooth_addr(TWS_U8* earphone_addr);
    void app_cvt213x_delay(TWS_U32 time_out_ms);

    int     app_cvt213x_i2c_init(void);
    TWS_S32 app_cvt213x_i2c_write_reg(tws_chip_index_e chipIndex, TWS_U16 reg_addr, TWS_U8* buff, TWS_U32 size);
    TWS_S32 app_cvt213x_i2c_read_reg(tws_chip_index_e chipIndex, TWS_U16 reg_addr, TWS_U8* buff, TWS_U32 size);
    void    app_cvt213x_count(void);
    void    app_cvt213x_irq_init(void);
    TWS_U8  app_cvt231x_irq_get_leavel(tws_chip_index_e chipIndex);
    TWS_U32 app_cvt213x_get_current_timer(void);
    void    app_cvt213x_poweron(TWS_BOOL flag);

    void     app_cvt213x_tone_up(void);
    void     app_cvt213x_tone_down(void);
    TWS_BOOL app_cvt213x_get_inbox_state_det_gpio(void);
    void     app_set_cvt213x_outbox_flag(TWS_BOOL flag);
    TWS_U8   cvt213x_get_touch_status(void);
    void     app_cvt213x_trigger_schedule(void);

    TWS_S8 app_cvt231x_flash_write(TWS_U8 buf[], TWS_U8 len);
    TWS_S8 app_cvt231x_flash_read(TWS_U8 buf[], TWS_U8 len);
    TWS_S8 app_cvt231x_setup_flash_write(TWS_U8 buf[], TWS_U8 len);
    TWS_S8 app_cvt231x_setup_flash_read(TWS_U8 buf[], TWS_U8 len);

    void    app_cvt213x_trx_init(void);
    TWS_S32 app_cvt213x_trx_spp_tx(TWS_U8* packet, TWS_U16 len);
    TWS_S32 app_cvt213x_trx_uart_tx(TWS_U8* packet, TWS_U16 len);

    void app_cvt213x_scheduler_init(void);

    /* Timer: 10ms periodic timer used to call app_cvt213x_count() */
    void app_cvt213x_timer_init(void);

    void app_cvt213x_event_handler(TWS_U16 event);
    void app_cvt213x_thread(u16 msg);
#ifdef __cplusplus
}
#endif

#endif
