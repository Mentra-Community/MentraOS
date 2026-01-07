/* app_cvt213x_shim.c
 * Minimal stubs for platform-specific functions used by CVT213X porting layer.
 * These are harmless defaults so the project builds under Zephyr; replace with
 * real implementations if hardware-specific behavior is required.
 */

#include "app_cvt213x_shim.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "app_cvt213x_main.h"
#include "app_cvt213x_porting.h" /* For app_cvt213x_thread, scheduler constants */
#include "cvt213x.h"
#include "interrupt_handler.h"  // For unified interrupt framework

LOG_MODULE_REGISTER(cvt213x_shim, LOG_LEVEL_DBG);

#define APP_CVT213X_MSGQ_MAX 16
K_MSGQ_DEFINE(app_cvt213x_msgq, sizeof(uint32_t), APP_CVT213X_MSGQ_MAX, 4);

K_THREAD_STACK_DEFINE(app_cvt213x_stack, 1024);
static struct k_thread app_cvt213x_tid;
struct k_timer        app_cvt213x_recheck_timer; /* Non-static for porting layer access */
static struct k_timer app_cvt213x_inear_debounce_timer;

extern void    app_cvt213x_thread(uint16_t msg);
extern TWS_U16 g_cvt213x_irq_flag;
extern TWS_U16 g_cvt213x_polling_flag;
extern uint8_t cvt213x_ied_get_last_prox_state(void);
extern void    app_cvt213x_scheduler_put_event(EARBUD_CVT213X_ID id);
extern TWS_U8  app_cvt231x_irq_get_leavel(tws_chip_index_e chipIndex);

#if DT_NODE_HAS_STATUS(DT_NODELABEL(i2c3), okay)
static const struct device* cvt_i2c_dev = DEVICE_DT_GET(DT_NODELABEL(i2c3));
#else
#warning "CVT213X: DT node 'i2c3' not present; enable i2c3 in your devicetree"
static const struct device* cvt_i2c_dev = NULL;
#endif

static const struct gpio_dt_spec cvt_int = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), cvt213x_int_gpios);
static struct gpio_callback      cvt_int_cb_data;

/* GPIO interrupt handler - called by Zephyr GPIO driver */
static void cvt213x_gpio_isr(const struct device* dev, struct gpio_callback* cb, uint32_t pins)
{
    ARG_UNUSED(dev);
    ARG_UNUSED(cb);
    ARG_UNUSED(pins);

    /* Directly raise CVT213X event to app thread (skip intermediate handler) */
    if (!app_cvt231x_irq_get_leavel(TWS_CHIP_0))
    {
        g_cvt213x_irq_flag = 1;

        /* Start 50ms recheck timer immediately to minimize I2C timing drift */
        k_timer_stop(&app_cvt213x_recheck_timer);
        k_timer_start(&app_cvt213x_recheck_timer, K_MSEC(50), K_NO_WAIT);

        // msg_enqueue(APP_MODUAL_CVT213X_IRQ);
    }
}

int cvt213x_hal_i2c_init(void)
{
    int ret = cvt213x_i2c_init();
    return ret;
}
int cvt213x_hal_i2c_verify(void)
{
    int ret = cvt213x_i2c_verify();
    return ret;
}
int cvt213x_hal_irq_init(void)
{
    if (!cvt_int.port || !device_is_ready(cvt_int.port))
    {
        LOG_ERR("cvt213x_hal_irq_init: int gpio not ready");
        return -ENODEV;
    }

    /* Configure GPIO as input with pull-up (CVT213X INT is active low) */
    int rc = gpio_pin_configure_dt(&cvt_int, GPIO_INPUT | GPIO_PULL_UP);
    if (rc)
    {
        LOG_ERR("cvt213x_hal_irq_init: gpio_pin_configure_dt failed %d", rc);
        return rc;
    }

    /* Configure interrupt on falling edge (active low) */
    rc = gpio_pin_interrupt_configure_dt(&cvt_int, GPIO_INT_EDGE_FALLING);
    if (rc)
    {
        LOG_ERR("cvt213x_hal_irq_init: gpio_pin_interrupt_configure_dt failed %d", rc);
        return rc;
    }

    /* Initialize and add the callback */
    gpio_init_callback(&cvt_int_cb_data, cvt213x_gpio_isr, BIT(cvt_int.pin));
    rc = gpio_add_callback(cvt_int.port, &cvt_int_cb_data);
    if (rc)
    {
        LOG_ERR("cvt213x_hal_irq_init: gpio_add_callback failed %d", rc);
        return rc;
    }

    LOG_INF("CVT213X GPIO interrupt initialized on P0.%d (falling edge)", cvt_int.pin);
    return 0;
}

void cvt213x_hal_irq_enable(void)
{
    if (!cvt_int.port || !device_is_ready(cvt_int.port))
    {
        LOG_WRN("cvt213x_hal_irq_enable: int gpio not ready");
        return;
    }

    int rc = gpio_pin_interrupt_configure_dt(&cvt_int, GPIO_INT_EDGE_FALLING);
    if (rc)
    {
        LOG_ERR("cvt213x_hal_irq_enable: failed %d", rc);
    }
    else
    {
        LOG_DBG("CVT213X interrupt enabled");
    }
}

void cvt213x_hal_irq_disable(void)
{
    if (!cvt_int.port || !device_is_ready(cvt_int.port))
    {
        LOG_WRN("cvt213x_hal_irq_disable: int gpio not ready");
        return;
    }

    int rc = gpio_pin_interrupt_configure_dt(&cvt_int, GPIO_INT_DISABLE);
    if (rc)
    {
        LOG_ERR("cvt213x_hal_irq_disable: failed %d", rc);
    }
    else
    {
        LOG_DBG("CVT213X interrupt disabled");
    }
}

uint8_t cvt213x_hal_irq_get_level(int chipIndex)
{
    ARG_UNUSED(chipIndex);

    if (!cvt_int.port || !device_is_ready(cvt_int.port))
    {
        LOG_WRN("cvt213x_hal_irq_get_level: int gpio not ready; returning 0");
        return 0;
    }

    int val = gpio_pin_get_raw(cvt_int.port, cvt_int.pin);
    /* Normalize to 0/1 */
    return (uint8_t)(val ? 1 : 0);
}

/* Hardware I2C helpers implemented on top of Zephyr I2C */
int cvt213x_hw_i2c_write(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size)
{
    if (!cvt_i2c_dev || !device_is_ready(cvt_i2c_dev))
    {
        LOG_ERR("cvt213x: i2c device not ready");
        return -ENODEV;
    }

    /* Compose register (big-endian) + payload */
    uint8_t tx_buf[2 + size];
    tx_buf[0] = (uint8_t)((reg >> 8) & 0xFF);
    tx_buf[1] = (uint8_t)(reg & 0xFF);
    if (size > 0 && buff != NULL)
    {
        memcpy(&tx_buf[2], buff, size);
    }

    int ret = i2c_write(cvt_i2c_dev, tx_buf, 2 + size, addr);
    if (ret)
    {
        LOG_WRN("cvt213x: i2c_write failed: %d", ret);
    }
    return ret;
}

int cvt213x_hw_i2c_read(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size)
{
    if (!cvt_i2c_dev || !device_is_ready(cvt_i2c_dev))
    {
        LOG_ERR("cvt213x: i2c device not ready");
        return -ENODEV;
    }

    uint8_t reg_be[2];
    reg_be[0] = (uint8_t)((reg >> 8) & 0xFF);
    reg_be[1] = (uint8_t)(reg & 0xFF);

    int ret = i2c_write_read(cvt_i2c_dev, addr, reg_be, sizeof(reg_be), buff, size);
    if (ret)
    {
        LOG_WRN("cvt213x: i2c_read failed: %d", ret);
    }
    return ret;
}

/* Backwards-compatible wrappers (old SW names kept for other usage) */
int cvt213x_sw_i2c_write(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size)
{
    return cvt213x_hw_i2c_write(addr, reg, buff, size);
}

int cvt213x_sw_i2c_read(uint8_t addr, uint16_t reg, uint8_t* buff, uint32_t size)
{
    return cvt213x_hw_i2c_read(addr, reg, buff, size);
}

/* Flash emulation stubs */
void cm_write(const void* buf, int page, int len)
{
    (void)buf;
    (void)page;
    (void)len;
}

void cm_sync(void)
{
}

void cm_read(void* buf, int page, int len)
{
    (void)buf;
    (void)page;
    (void)len;
}

/* Bluetooth SPP stub */
int bt_spp_tx(const void* packet, int len)
{
    (void)packet;
    (void)len;
    return 0;
}

/* Message queue: push event to scheduler message queue (used by porting layer) */
void msg_enqueue(int e)
{
    uint32_t ev = (uint32_t)e;
    int      rc = k_msgq_put(&app_cvt213x_msgq, &ev, K_NO_WAIT);
    if (rc != 0)
    {
        LOG_WRN("msg_enqueue: msgq full, dropping event 0x%x", e);
    }
}

/* BSP compatibility: legacy init and delay hooks (Zephyr-managed I2C, so init is a no-op) */
void bsp_i2c_init(void)
{
    /* CVT213X uses Zephyr devicetree-managed I2C; keep hook for legacy code paths */
}

void delay_ms(uint32_t ms)
{
    k_msleep(ms);
}

/* 50ms debounce timer to mirror BES2300 debounce helper behavior */
static void app_cvt213x_inear_debounce_timer_handler(struct k_timer* timer)
{
    ARG_UNUSED(timer);

    if (!cvt213x_ied_get_last_prox_state())
    {
        g_cvt213x_polling_flag = 1;
        app_cvt213x_scheduler_put_event(APP_MODUAL_CVT213X_IRQ);
    }
}

/* 50ms recheck timer callback - checks if interrupt pin is still low */
static void app_cvt213x_recheck_timer_handler(struct k_timer* timer)
{
    ARG_UNUSED(timer);

    /* Check if interrupt pin is still low */
    if (!app_cvt231x_irq_get_leavel(TWS_CHIP_0)) /* TWS_CHIP_0 = 0 */
    {
        g_cvt213x_irq_flag = 1;
        if (!cvt213x_ied_get_last_prox_state())
        {
            g_cvt213x_polling_flag = 1;
        }
        app_cvt213x_scheduler_put_event(APP_MODUAL_CVT213X_IRQ);
    }
}

static void app_cvt213x_thread_entry(void* p1, void* p2, void* p3)
{
    ARG_UNUSED(p1);
    ARG_UNUSED(p2);
    ARG_UNUSED(p3);
    uint32_t ev;
    while (1)
    {
        if (k_msgq_get(&app_cvt213x_msgq, &ev, K_FOREVER) == 0)
        {
            app_cvt213x_thread((u16)ev);
        }
    }
}

void app_cvt213x_timer_init(void)
{
    /* Initialize recheck timer (one-shot, started on demand) */
    k_timer_init(&app_cvt213x_recheck_timer, app_cvt213x_recheck_timer_handler, NULL);

    /* Initialize debounce timer (one-shot) used by in-ear debounce helpers */
    k_timer_init(&app_cvt213x_inear_debounce_timer, app_cvt213x_inear_debounce_timer_handler, NULL);
}

void app_hal_cvt213x_scheduler_init(void)
{
    LOG_INF("app_hal_cvt213x_scheduler_init(): enter");

    /* Initialize periodic timer to drive CVT213X timing (10ms tick) */
    app_cvt213x_timer_init();

    /* Create worker thread to process CVT213X events from a message queue */
    k_thread_create(&app_cvt213x_tid, app_cvt213x_stack, K_THREAD_STACK_SIZEOF(app_cvt213x_stack),
                    app_cvt213x_thread_entry, NULL, NULL, NULL, K_PRIO_PREEMPT(3), 0, K_NO_WAIT);

    /* porting TODO:(optional) host platform scheduler init */
}

void app_cvt213x_inear_debounce_restart(void)
{
    if (!cvt213x_ied_get_last_prox_state())
    {
#if !(CVT213X_DROP_STEP_FUN)
        k_timer_start(&app_cvt213x_inear_debounce_timer, K_MSEC(50), K_NO_WAIT);
#endif
    }
}

void app_cvt213x_inear_debounce_stop(void)
{
    if (!cvt213x_ied_get_last_prox_state())
    {
#if !(CVT213X_DROP_STEP_FUN)
        k_timer_stop(&app_cvt213x_inear_debounce_timer);
#endif
    }
}
