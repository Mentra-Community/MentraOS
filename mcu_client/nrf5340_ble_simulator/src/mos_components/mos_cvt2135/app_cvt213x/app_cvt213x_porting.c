/*******************************************************************************
 * Copyright (C) 2020-2025, CVA Systems (R),All Rights Reserved.
 *
 * File:         app_cvt213x_porting.c
 * Description:
 * Version：      V2.0
 * Date：         2021-11-16
 * Author：       CVA Software Team
 *******************************************************************************/

/*******************************************************************************
 * 1.Included header files
 *******************************************************************************/
#include "app_cvt213x_porting.h"

#include "app_cvt213x_main.h"
#include "app_cvt213x_shim.h"
#include "cvt213x.h"
#include "interrupt_handler.h" /* Unified interrupt framework */

/* Zephyr kernel for timer APIs */
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(app_cvt213x_porting, LOG_LEVEL_INF);
/* Platform compatibility shims for Zephyr build */
#ifndef AT
#define AT(x)
#endif

#ifndef BIT
#define BIT(x) (1U << (x))
#endif

#ifndef CVT213X_PAGE
#define CVT213X_PAGE(x) (x)
#endif

/* Replace direct register access IRQ macros with no-op implementations on Zephyr */
#undef CVT2135_IRQ_INIT
#define CVT2135_IRQ_INIT()                           \
    do                                               \
    { /* no-op: board config is handled elsewhere */ \
    } while (0)

#undef CVT213X_IRQ_LEVEL
#define CVT213X_IRQ_LEVEL() (0)

/*******************************************************************************
 * 2.Private constant and macro definitions using #define
 *******************************************************************************/
// int config
#ifndef CVT2135_IRQ_INIT
#define CVT2135_IRQ_INIT()   \
    {                        \
        GPIOBDE |= BIT(5);   \
        GPIOBDIR |= BIT(5);  \
        GPIOBPU |= BIT(5);   \
        GPIOEFEN &= ~BIT(5); \
    }
#endif

#ifndef CVT213X_IRQ_LEVEL
#define CVT213X_IRQ_LEVEL() (GPIOB & BIT(5))
#endif

#if DUAL_CVT213X_ENABLE
#ifndef CVT2135_IRQ_2ND_INIT
#define CVT2135_IRQ_2ND_INIT() \
    {                          \
        GPIOBDE |= BIT(6);     \
        GPIOBDIR |= BIT(6);    \
        GPIOBPU |= BIT(6);     \
        GPIOEFEN &= ~BIT(6);   \
    }
#endif

#ifndef CVT213X_IRQ_2ND_LEVEL
#define CVT213X_IRQ_2ND_LEVEL() (GPIOB & BIT(6))
#endif
#endif

#define CVT213X_SUPPERSSION_TOUCH_EN    0  // suppression touch
#define CVT213X_SUPPERSSION_TOUCH_TIMER 1500
/*******************************************************************************
 * 3.Private enumerations, structures and unions using typedef
 *******************************************************************************/

/*******************************************************************************
 * 4.Static variables
 *******************************************************************************/
#if CVT213X_SUPPERSSION_TOUCH_EN
TWS_U8      g_tk_suppression_flag  = 0;
TWS_U16     g_tk_suppression_count = 0;
tws_event_e g_is_in_ear_flag       = TWS_EVENT_IED_OFF;
static void app_cvt213x_touch_suppression_callback(void);
#endif
/*******************************************************************************
 * 5.Global variable or extern global variabls/functions
 *******************************************************************************/
// log等级 LOG_LEVEL_ERR: 3   LOG_LEVEL_WRO: 2  LOG_LEVEL_DBG:1
TWS_U8 g_cvt213x_app_level = 1;
TWS_U8 g_cvt213x_lib_level = 1;
TWS_U8 g_cvt213x_trx_level = 1;
// irq time
TWS_U16 g_cvt213x_tick_cnt     = 0;
TWS_U16 g_cvt213x_polling_flag = 0;
TWS_U16 g_cvt213x_irq_flag     = 0;
// touch
TWS_BOOL g_cvt213x_outbox_flag = FALSE;

TWS_U8 cvt213x_tone_flag      = 0;
TWS_U8 g_cvt213x_touch_status = 0;

#if ((CVT213X_TRX_EN) & (CVT213X_TK_CALC_BY_SDK))
extern TWS_U8 cvt213x_get_test_mode_status(void);
#endif

extern void i2c_init(u32 cfg);

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void cvt213x_cmd_read_bluetooth_addr(TWS_U8* earphone_addr)
{
    CVT213X_APP_LOG_D(0, "cvt213x_cmd_read_bluetooth_addr(): enter");

    // porting TODO:(optional) host platform peripheral driver
    CVT213X_UNUSED(earphone_addr);
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note use for earphone outbox frist time, inear detection
 ****************************************************************/
void app_set_cvt213x_outbox_flag(TWS_BOOL flag)
{
    g_cvt213x_outbox_flag = flag;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note get earphone box_state:1 inbox  0 outbox
 ****************************************************************/
TWS_BOOL app_cvt213x_get_inbox_state_det_gpio(void)
{
    // TODO get earphone box_state:1 inbox  0 outbox

    return 1;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note use for earphone outbox frist time, inear detection
 ****************************************************************/
void app_cvt213x_trigger_schedule(void)
{
    if (!cvt213x_ied_get_last_prox_state())
    {
        g_cvt213x_polling_flag = 1;
        app_cvt213x_scheduler_put_event(APP_MODUAL_CVT213X_IRQ);
    }
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note LDO for cvt213x VDD,turn on :true,turn off :false
 ****************************************************************/
void app_cvt213x_poweron(TWS_BOOL flag)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_poweron(): enter");

    // porting TODO:(optional) host platform peripheral driver
    CVT213X_UNUSED(flag);
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note unit ms
 ****************************************************************/
void app_cvt213x_delay(TWS_U32 time_out_ms)
{
    // CVT213X_APP_LOG_D(0, "app_cvt213x_delay(): enter");

    // porting TODO: host platform peripheral driver
    CVT213X_UNUSED(time_out_ms);

    delay_ms(time_out_ms);
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_U32 app_cvt213x_get_current_timer(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_get_current_timer(): enter");

    // porting TODO: host platform peripheral dirver

    return 0;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
int app_cvt213x_i2c_init(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_i2c_init(): initializing I2C for CVT213X");

    /* Call Zephyr/nRF5340 HAL I2C initialization */
    int ret = cvt213x_hal_i2c_init();
    if (ret != 0)
    {
        CVT213X_APP_LOG_E(1, "app_cvt213x_i2c_init(): I2C HAL init failed with error %d", ret);
        return ret;
    }

    CVT213X_APP_LOG_D(0, "app_cvt213x_i2c_init(): I2C initialized successfully");
    return 0;

    /* Legacy platform-specific I2C initialization (disabled for Zephyr)
     * Uncomment if porting to non-Zephyr platforms:
     * #if I2C_HW_EN
     *     GPIOEDE |= BIT(6) | BIT(5);     // 数字IO使能
     *     GPIOEDIR |= BIT(6) | BIT(5);    // IO方向配置
     *     GPIOEPU300 |= BIT(6) | BIT(5);  // 300Ω上拉
     *     GPIOEFEN |= BIT(6) | BIT(5);    // 功能IO配置
     *     FUNCMCON2 = I2CMAP_PE6PE5;      // 映射IIC IO口
     *     i2c_init(0);
     * #else
     *     bsp_i2c_init();
     * #endif
     */
}

int app_cvt213x_i2c_verify(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_i2c_verify(): verifying I2C for CVT213X");

    /* Call into Zephyr driver verify routine (uses i2c3 only) */
    return cvt213x_hal_i2c_verify();
}

/*****************************************************************
 * @brief
 * @param[in]  None
 * @param[out] None
 * @retval     None
 * @note
 ****************************************************************/
TWS_S32 app_cvt213x_i2c_write_reg(tws_chip_index_e chipIndex, TWS_U16 reg_addr, TWS_U8* buff, TWS_U32 size)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_i2c_write_reg(): enter");

    /* Use shim (Zephyr I2C) implementation — keep the original legacy
     * implementation disabled for reference. */
    (void)chipIndex;
    (void)reg_addr;

    uint8_t addr7 = CVT213X_I2C_7BITS_ADDRESS_W;
#if DUAL_CVT213X_ENABLE
    if (chipIndex == TWS_CHIP_1)
    {
        addr7 = CVT213X_I2C_2ND_7BITS_ADDRESS_W;
    }
#endif

    int rc = cvt213x_hw_i2c_write(addr7, reg_addr, buff, size);
    if (rc)
    {
        CVT213X_APP_LOG_E(1, "cvt213x hw i2c write failed: %d", rc);
        return (TWS_S32)rc;
    }

#if 0
    // legacy platform implementation
    CVT213X_UNUSED(chipIndex);
    CVT213X_UNUSED(reg_addr);
    CVT213X_UNUSED(buff);
    CVT213X_UNUSED(size);

    if (chipIndex == TWS_CHIP_0)
    {
#if I2C_HW_EN
        reg_addr = ((reg_addr & 0xff) << 8) | (reg_addr >> 8);
        cvt213x_hw_i2c_write(CVT213X_I2C_8BITS_ADDRESS_W, reg_addr, buff, size);
#else
        cvt213x_sw_i2c_write(CVT213X_I2C_8BITS_ADDRESS_W, reg_addr, buff, size);
#endif
    }
#if DUAL_CVT213X_ENABLE
    else if (chipIndex == TWS_CHIP_1)
    {
#if I2C_HW_EN
        reg_addr = ((reg_addr & 0xff) << 8) | (reg_addr >> 8);
        cvt213x_hw_i2c_write(CVT213X_I2C_2ND_8BITS_ADDRESS_W, reg_addr, buff, size);
#else
        cvt213x_sw_i2c_write(CVT213X_I2C_2ND_8BITS_ADDRESS_W, reg_addr, buff, size);
#endif
    }
#endif
#endif

    return 0;
}

/*****************************************************************
 * @brief
 * @param[in]  None
 * @param[out] None
 * @retval     None
 * @note
 ****************************************************************/
TWS_S32 app_cvt213x_i2c_read_reg(tws_chip_index_e chipIndex, TWS_U16 reg_addr, TWS_U8* buff, TWS_U32 size)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_i2c_read_reg(): enter");

    uint8_t addr7 = CVT213X_I2C_7BITS_ADDRESS_W;
#if DUAL_CVT213X_ENABLE
    if (chipIndex == TWS_CHIP_1)
    {
        addr7 = CVT213X_I2C_2ND_7BITS_ADDRESS_W;
    }
#endif

    int rc = cvt213x_hw_i2c_read(addr7, reg_addr, buff, size);
    if (rc)
    {
        CVT213X_APP_LOG_E(1, "cvt213x hw i2c read failed: %d", rc);
        return (TWS_S32)rc;
    }

#if 0
    // legacy platform implementation
    CVT213X_UNUSED(chipIndex);
    CVT213X_UNUSED(reg_addr);
    CVT213X_UNUSED(buff);
    CVT213X_UNUSED(size);

    if (chipIndex == TWS_CHIP_0)
    {
#if I2C_HW_EN
        reg_addr = ((reg_addr & 0xff) << 8) | (reg_addr >> 8);
        cvt213x_hw_i2c_read(CVT213X_I2C_8BITS_ADDRESS_W, reg_addr, buff, size);
#else
        cvt213x_sw_i2c_read(CVT213X_I2C_8BITS_ADDRESS_W, reg_addr, buff, size);
#endif
    }
#if DUAL_CVT213X_ENABLE
    else if (chipIndex == TWS_CHIP_1)
    {
#if I2C_HW_EN
        reg_addr = ((reg_addr & 0xff) << 8) | (reg_addr >> 8);
        cvt213x_hw_i2c_read(CVT213X_I2C_2ND_8BITS_ADDRESS_W, reg_addr, buff, size);
#else
        cvt213x_sw_i2c_read(CVT213X_I2C_2ND_8BITS_ADDRESS_W, reg_addr, buff, size);
#endif
    }
#endif
#endif

    return 0;
}

#if (CVT213X_TK_CALC_BY_SDK || IS_TK_ENABLE)
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_tone_up(void)
{
    CVT213X_APP_LOG_E(0, "app_cvt213x_tone_up(): enter");

    // porting TODO:(optional) host platform peripheral driver
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_tone_down(void)
{
    CVT213X_APP_LOG_E(0, "app_cvt213x_tone_down(): enter");

    // porting TODO:(optional) host platform peripheral driver
}
#endif

#if CVT213X_TK_CALC_BY_SDK
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
static void cvt213x_set_touch_status(tws_chip_index_e chipIndex)
{
    TWS_U8 proximity_state[1] = {0};
    CVT213X_APP_LOG_D(0, "cvt213x_set_touch_status() enter");

    cvt213x_i2c_read_touch_state(chipIndex, proximity_state);
    cvt213x_i2c_clear_int(chipIndex);
    g_cvt213x_touch_status = (proximity_state[0] & 0x01);

    if ((cvt213x_tone_flag == 0) && (g_cvt213x_touch_status == 0x01))
    {
        app_cvt213x_tone_down();
        cvt213x_tone_flag = 1;
    }
    if ((cvt213x_tone_flag == 1) && (g_cvt213x_touch_status == 0x00))
    {
        app_cvt213x_tone_up();
        cvt213x_tone_flag = 0;
    }
}
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_U8 cvt213x_get_touch_status(void)
{
    return g_cvt213x_touch_status;
}
#endif

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
AT(.com_text.timer)
void app_cvt213x_count(void)
{
    g_cvt213x_tick_cnt++;
    if (g_cvt213x_tick_cnt % 1 == 0)  // 10ms
    {
        g_cvt213x_irq_flag = 1;
    }
    if (g_cvt213x_tick_cnt % 5 == 0)  // 50ms
    {
        g_cvt213x_polling_flag = 1;
        g_cvt213x_tick_cnt     = 0;
    }
#if CVT213X_SUPPERSSION_TOUCH_EN
    if (g_tk_suppression_flag == 1)
    {
        g_tk_suppression_count++;
        if (g_tk_suppression_count % (CVT213X_SUPPERSSION_TOUCH_TIMER) == 0)
        {
            g_tk_suppression_count = 0;
            app_cvt213x_touch_suppression_callback();
        }
    }
#endif
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_irq_callback(void)
{
    // static TWS_U8 cva_irq_count=0;
    // cva_irq_count++;
    // CVT213X_APP_LOG_D(2,"%s  app_cvt213x_irq_callback cva_irq_count=%d",__func__,cva_irq_count);

    // irq handler
    if (!app_cvt231x_irq_get_leavel(TWS_CHIP_0))
    {
        g_cvt213x_irq_flag = 1;
        if (!cvt213x_ied_get_last_prox_state())
        {
            g_cvt213x_polling_flag = 1;
        }
        app_cvt213x_scheduler_put_event(APP_MODUAL_CVT213X_IRQ);
    }

    //     app_cvt213x_count();

    //     if ((g_cvt213x_irq_flag) || (g_cvt213x_polling_flag))
    //     {
    //         app_cvt213x_scheduler_put_event(APP_MODUAL_CVT213X_IRQ);
    //     }
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void app_cvt213x_irq_enable(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_irq_enable(): enter");

    //porting TODO:(optional) host platform peripheral driver
}

/*****************************************************************
  * @brief
  * @param[in]
  * @param[out]
  * @retval
  * @note
  ****************************************************************/
void app_cvt213x_irq_disable(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_irq_disable(): enter");

    //porting TODO:(optional) host platform peripheral driver
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_irq_init(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_irq_init(): enter");

    // porting TODO: host platform peripheral driver
    //  GPIOEDE  |= BIT(4); //数字IO使能: 0为模拟IO, 1 为数字IO
    //  GPIOEDIR |= BIT(4); //控制IO的方向: 0为输出, 1为输入.
    //  GPIOEFEN &= ~BIT(4);//0:当作通用GPIO使用 //1:当作其它功能性IO,如串口/SPI..
    //  GPIOEPU  |= BIT(4); //10K上拉使能
    // CVT2135_IRQ_INIT();

    cvt213x_hal_irq_init();

#if DUAL_CVT213X_ENABLE
    // GPIOEDE  |= BIT(5); //数字IO使能: 0为模拟IO, 1 为数字IO
    // GPIOEDIR |= BIT(5); //控制IO的方向: 0为输出, 1为输入.
    // GPIOEFEN &= ~BIT(5);//0:当作通用GPIO使用 //1:当作其它功能性IO,如串口/SPI..
    // GPIOEPU  |= BIT(5); //10K上拉使能
    CVT2135_IRQ_2ND_INIT();
#endif
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_U8 app_cvt231x_irq_get_leavel(tws_chip_index_e chipIndex)
{
    CVT213X_APP_LOG_D(0, "app_cvt231x_irq_get_leavel(): enter");

    uint8_t level = cvt213x_hal_irq_get_level((int)chipIndex);

#if 0
    // legacy platform implementation
    if (chipIndex == TWS_CHIP_0)
    {
        return CVT213X_IRQ_LEVEL();
    }
#if DUAL_CVT213X_ENABLE
    else if (chipIndex == TWS_CHIP_1)
    {
        return CVT213X_IRQ_2ND_LEVEL();
    }
#endif
    else
    {
        return 1;
    }
#endif

    return level;
}

#if CVT213X_FLASH_EN
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S8 app_cvt231x_flash_write(TWS_U8 buf[], TWS_U8 len)
{
    CVT213X_APP_LOG_D(0, "app_cvt231x_flash_write(): enter");

    // porting TODO:(optional) host platform peripheral driver
    CVT213X_UNUSED(buf);
    CVT213X_UNUSED(len);

    // for (TWS_U8 index = 0; index < len; index++)
    // {
    //     CVT213X_APP_LOG_D(2, "cali info write:buf[%02x]:0x%02x", index, buf[index]);
    // }
    if (len == 16)
    {
        cm_write(buf, CVT213X_PAGE(0), len);  // 校准值
    }
    cm_sync();

    return 0;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S8 app_cvt231x_flash_read(TWS_U8 buf[], TWS_U8 len)
{
    CVT213X_APP_LOG_D(0, "app_cvt231x_flash_read(): enter");

    // porting TODO:(optional) host platform peripheral dirver
    CVT213X_UNUSED(buf);
    CVT213X_UNUSED(len);

    if (len == 16)
    {
        cm_read(buf, CVT213X_PAGE(0), len);  // 校准值
    }

    // for (TWS_U8 index = 0; index < len; index++)
    // {
    //     CVT213X_APP_LOG_D(2, "cali info read: buf[%02x]:0x%02x", index, buf[index]);
    // }

    return 0;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S8 app_cvt231x_setup_flash_write(TWS_U8 buf[], TWS_U8 len)
{
    CVT213X_APP_LOG_D(0, "app_cvt231x_setup_flash_write(): enter");

    // porting TODO:(optional) host platform peripheral driver
    CVT213X_UNUSED(buf);
    CVT213X_UNUSED(len);

    // for (TWS_U8 index = 0; index < len; index++)
    // {
    //     CVT213X_APP_LOG_D(2, "setup info write: buf[%02x]:0x%02x", index, buf[index]);
    // }

    return 0;
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S8 app_cvt231x_setup_flash_read(TWS_U8 buf[], TWS_U8 len)
{
    CVT213X_APP_LOG_D(0, "app_cvt231x_setup_flash_read(): enter");

    // porting TODO:(optional) host platform peripheral driver
    CVT213X_UNUSED(buf);
    CVT213X_UNUSED(len);

    // for (TWS_U8 index = 0; index < len; index++)
    // {
    //     CVT213X_APP_LOG_D(2, "setup info read buf[%02x]:0x%02x", index, buf[index]);
    // }

    return 0;
}
#endif

#if CVT213X_TRX_EN
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_trx_init(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_trx_init(): enter");

    // porting TODO:(optional) host platform peripheral driver
    app_cvt213x_trx_uart_rx_packet_init();
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S32 app_cvt213x_trx_spp_tx(TWS_U8* packet, TWS_U16 len)
{
    // CVT213X_APP_LOG_D(0, "app_cvt213x_trx_spp_tx(): enter");

    // porting TODO: host platform peripheral driver
    CVT213X_UNUSED(packet);
    CVT213X_UNUSED(len);

    // for (TWS_U8 index = 0; index < len; index++)
    // {
    //     CVT213X_APP_LOG_D(2, "app_cvt213x_spp_tx:packet[%02x]:0x%02x", index, packet[index]);
    // }

    return (TWS_S32)bt_spp_tx(packet, len);
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
TWS_S32 app_cvt213x_trx_uart_tx(TWS_U8* packet, TWS_U16 len)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_trx_uart_tx(): enter");

    // porting TODO:(optional) host platform peripheral driver
    CVT213X_UNUSED(packet);
    CVT213X_UNUSED(len);

    // for (TWS_U8 index = 0; index < len; index++)
    // {
    //     CVT213X_APP_LOG_D(2, "app_cvt213x_trx_uart_tx:packet[%02x]:0x%02x", index, packet[index]);
    // }

#if VUSB_HUART_DMA_EN
    huart_putcs(buf, len);
#else
    for (u8 i = 0; i < len; i++)
    {
        // vusb_uart_putchar(packet[i]);
        CVT213X_APP_LOG_D(2, "%d : uart tx 0x%x\n", i, packet[i]);
    }
#endif
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
void app_cvt213x_thread(u16 msg)
{
    if (g_cvt213x_irq_flag)
    {
        g_cvt213x_irq_flag = 0;
        if (cvt213x_util_get_init_flag(TWS_CHIP_0) == INIT_DONE)
        {
            if ((!app_cvt231x_irq_get_leavel(TWS_CHIP_0)) || (cvt213x_get_scan_mode(TWS_CHIP_0) == ACTIVE_MODE))
            {
#if CVT213X_TK_CALC_BY_SDK
                if (((cvt213x_get_scan_mode(TWS_CHIP_0) != DOZE_MODE)
                     && (cvt213x_get_scan_mode(TWS_CHIP_0) != ACTIVE_MODE))
#if CVT213X_TRX_EN
                    || (cvt213x_get_test_mode_status() == 0)
#endif
                        )  // cvt213x初始完成后，使用SDK按键流程;
                {
                    app_cvt213x_scheduler_handler(APP_MODUAL_CVT213X_IRQ);
                }
#else
                app_cvt213x_scheduler_handler(APP_MODUAL_CVT213X_IRQ);
#endif
            }
        }

#if DUAL_CVT213X_ENABLE
        if (cvt213x_util_get_init_flag(TWS_CHIP_1) == INIT_DONE)
        {
            if ((!app_cvt231x_irq_get_leavel(TWS_CHIP_1)) || (cvt213x_get_scan_mode(TWS_CHIP_1) == ACTIVE_MODE))
            {
                app_cvt213x_scheduler_handler(APP_MODUAL_CVT213X_IRQ_2ND);
            }
        }
#endif
    }

#if CVT213X_TK_CALC_BY_SDK
    // 使用SDK按键流程
    if ((cvt213x_get_scan_mode(TWS_CHIP_0) == DOZE_MODE) || ((cvt213x_get_scan_mode(TWS_CHIP_0) == ACTIVE_MODE)))
    {
        if (!app_cvt231x_irq_get_leavel(TWS_CHIP_0))
            cvt213x_set_touch_status(TWS_CHIP_0);
    }
#endif
    if (g_cvt213x_polling_flag)
    {
        g_cvt213x_polling_flag = 0;
        if ((cvt213x_get_scan_mode(TWS_CHIP_0) == DOZE_MODE) || ((cvt213x_get_scan_mode(TWS_CHIP_0) == ACTIVE_MODE)))
        {
            app_cvt213x_polling_handler(TWS_CHIP_0);
        }

#if (CVT213X_IC_TYPE_SELECT != IC_TYPE_CVT2138)
        // TWS_S32 rd_raw[5] = {0};
        // TWS_S32 rd_avg[5] = {0};
        // TWS_S32 rd_diff[5] = {0};
        // cvt213x_i2c_read_phase_raw_data(TWS_CHIP_0,rd_raw);
        // cvt213x_i2c_read_phase_avg_data(TWS_CHIP_0,rd_avg);
        // cvt213x_i2c_read_phase_diff_data(TWS_CHIP_0,rd_diff);
        // CVT213X_APP_LOG_D(5, "raw: %07d, %07d, %07d, %07d, %07d", rd_raw[0], rd_raw[1], rd_raw[2], rd_raw[3],
        // rd_raw[4]); CVT213X_APP_LOG_D(5, "avg: %07d, %07d, %07d, %07d, %07d", rd_avg[0], rd_avg[1], rd_avg[2],
        // rd_avg[3], rd_avg[4]); CVT213X_APP_LOG_D(5, "diff: %07d, %07d, %07d, %07d, %07d", rd_diff[0], rd_diff[1],
        // rd_diff[2], rd_diff[3], rd_diff[4]);
#else
        // TWS_S32 rd_raw[8] = {0};
        // TWS_S32 rd_avg[8] = {0};
        // TWS_S32 rd_diff[8] = {0};
        // cvt213x_i2c_read_phase_raw_data(TWS_CHIP_0,rd_raw);
        // cvt213x_i2c_read_phase_avg_data(TWS_CHIP_0,rd_avg);
        // cvt213x_i2c_read_phase_diff_data(TWS_CHIP_0,rd_diff);
        // CVT213X_APP_LOG_D(8, "raw: %07d, %07d, %07d, %07d, %07d, %07d, %07d, %07d", rd_raw[0], rd_raw[1], rd_raw[2],
        // rd_raw[3], rd_raw[4], rd_raw[5], rd_raw[6], rd_raw[7]); CVT213X_APP_LOG_D(8, "avg: %07d, %07d, %07d, %07d,
        // %07d, %07d, %07d, %07d", rd_avg[0], rd_avg[1], rd_avg[2], rd_avg[3], rd_avg[4], rd_avg[5], rd_avg[6],
        // rd_avg[7]); CVT213X_APP_LOG_D(8, "diff: %07d, %07d, %07d, %07d, %07d, %07d, %07d, %07d", rd_diff[0],
        // rd_diff[1], rd_diff[2], rd_diff[3], rd_diff[4], rd_diff[5], rd_diff[6], rd_diff[7]);
#endif
    }
    switch (msg)
    {
        case APP_MODUAL_CVT213X_IRQ:
            break;
        case APP_MODUAL_CVT213X_TRX_START:
            app_cvt213x_scheduler_handler(APP_MODUAL_CVT213X_TRX_START);
            break;
        case APP_MODUAL_CVT213X_TRX_END:
            app_cvt213x_scheduler_handler(APP_MODUAL_CVT213X_TRX_END);
            break;
        case APP_MODUAL_CVT213X_TRX_DATA:
            app_cvt213x_scheduler_handler(APP_MODUAL_CVT213X_TRX_DATA);
            break;
        default:
            break;
    }
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_scheduler_init(void)
{
    CVT213X_APP_LOG_D(0, "app_cvt213x_scheduler_init(): enter");

    // porting TODO:(optional) host platform scheduler init
    app_hal_cvt213x_scheduler_init();
}

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_scheduler_put_event(EARBUD_CVT213X_ID id)
{
    // CVT213X_APP_LOG_D(1, "app_cvt213x_scheduler_put_event(): enter, id:0x%x", id);

    // porting TODO: host platform scheduler put event
    switch (id)
    {
        case APP_MODUAL_CVT213X_IRQ:
        {
            msg_enqueue(APP_MODUAL_CVT213X_IRQ);
            break;
        }

        case APP_MODUAL_CVT213X_TRX_START:
        {
            msg_enqueue(APP_MODUAL_CVT213X_TRX_START);
            break;
        }

        case APP_MODUAL_CVT213X_TRX_END:
        {
            msg_enqueue(APP_MODUAL_CVT213X_TRX_END);
            break;
        }

        case APP_MODUAL_CVT213X_TRX_DATA:
        {
            msg_enqueue(APP_MODUAL_CVT213X_TRX_DATA);
            break;
        }

        default:
            break;
    }
}
/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
#if CVT213X_SUPPERSSION_TOUCH_EN
static void app_cvt213x_touch_suppression_callback(void)
{
    g_tk_suppression_flag = 0;

    cvt213x_gesture_var_init(TWS_CHIP_0);
}
#endif

/*****************************************************************
 * @brief
 * @param[in]
 * @param[out]
 * @retval
 * @note
 ****************************************************************/
void app_cvt213x_event_handler(TWS_U16 event)
{
    tws_event_e ied_event = (tws_event_e)(event & TWS_IED_EVENT_MSK);
    tws_event_e tk_event  = (tws_event_e)(event & TWS_TK_EVENT_MSK);

#if CVT213X_SUPPERSSION_TOUCH_EN
    // 先入耳，按键才有效
    if ((g_is_in_ear_flag == TWS_EVENT_IED_OFF) && (ied_event == TWS_EVENT_IED_ON))
    {
        g_tk_suppression_flag = 1;
    }
    if (ied_event == TWS_EVENT_IED_OFF)
    {
        g_is_in_ear_flag = TWS_EVENT_IED_OFF;
    }
    else if (ied_event == TWS_EVENT_IED_ON)
    {
        g_is_in_ear_flag = TWS_EVENT_IED_ON;
    }
    if ((g_is_in_ear_flag == TWS_EVENT_IED_OFF) || (g_tk_suppression_flag == 1))
    {
        tk_event = TWS_EVENT_NONE;
    }
#endif
    // 入耳/出耳事件处理
    switch (ied_event)
    {
        case TWS_EVENT_IED_OFF:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_IED_OFF\n");
// porting TODO: host platform handling out-ear event
#if DUAL_CVT213X_ENABLE
#if (!CVT213X_IED_TK_SEPARATE_EN)
            cvt213x_sleep(TWS_CHIP_1);
#endif
#endif

            break;
        }

        case TWS_EVENT_IED_ON:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_IED_ON\n");
// porting TODO: host platform handling in-ear event
#if DUAL_CVT213X_ENABLE
#if (!CVT213X_IED_TK_SEPARATE_EN)
            {
                TWS_S8 ret = cvt213x_init(TWS_CHIP_1);
                if (ret)
                {
                    CVT213X_APP_LOG_E(1, "chip1 cvt213x write reg failed, ret = %d", ret);
                }
                else
                {
                    CVT213X_APP_LOG_D(0, "chip1 cvt213x write reg ok");
                }
            }
#endif
#endif

            break;
        }

        default:
            break;
    }
    // 按键/滑动事件处理
    switch (tk_event)
    {
        case TWS_EVENT_LONG_PRESS:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_LONG_PRESS\n");
            // porting TODO: host platform handling long-press event
            break;
        }

        case TWS_EVENT_LONGLONG_PRESS:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_LONGLONG_PRESS\n");
            // porting TODO: host platform handling longlong-press event
            break;
        }

        case TWS_EVENT_SINGLE_CLICK_AND_LONG_PRESS:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_SINGLE_CLICK_AND_LONG_PRESS\n");
            // porting TODO: host platform handling single click long event
            break;
        }

        case TWS_EVENT_DOUBLE_CLICK_AND_LONG_PRESS:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_DOUBLE_CLICK_AND_LONG_PRESS\n");
            // porting TODO: host platform handling double click long event
            break;
        }

        case TWS_EVENT_SINGLE_CLICK:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_SINGLE_CLICK\n");
            // porting TODO: host platform handling single-click event
            break;
        }

        case TWS_EVENT_DOUBLE_CLICK:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_DOUBLE_CLICK\n");
            // porting TODO: host platform handling double-click event
            break;
        }

        case TWS_EVENT_TRIPLE_CLICK:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_TRIPLE_CLICK\n");
            // porting TODO: host platform handling triple-click event
            break;
        }

        case TWS_EVENT_FOURTH_CLICK:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_FOURTH_CLICK\n");
            // porting TODO: host platform handling fourth-click event
#if CVT213X_SETUP_FUN
            app_cvt213x_save_offset_to_flash();  // test
#endif
            break;
        }

        case TWS_EVENT_FIFTH_CLICK:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_FIFTH_CLICK\n");
            // porting TODO: host platform handling fifth-click event
#if CVT213X_SETUP_FUN
            cvt213x_is_earphone_in_box_state_set(0);  // test
            cvt213x_wakeup(TWS_CHIP_0);
            app_cvt213x_calibration_speed_up();
            // app_cvt213x_timer_init();
#endif
            break;
        }

        case TWS_EVENT_SLIDE_UP:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_SLIDE_UP\n");
            // porting TODO: host platform handling slide-up event
            break;
        }

        case TWS_EVENT_SLIDE_DOWN:
        {
            CVT213X_APP_LOG_E(0, "\nTWS_EVENT_SLIDE_DOWN\n");
            // porting TODO: host platform handling slide-down event
            break;
        }

        default:
            break;
    }
}
