/*
 * @Author       : Cole
 * @Date         : 2026-01-24 11:14:00
 * @LastEditTime : 2026-02-05 14:21:41
 * @FilePath     : mos_button_app.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2026
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "mos_button_app.h"

#include <display/lcd/a6n.h>  // For a6n_power_off()
#include <hal/nrf_gpio.h> /* For direct GPIO control | 直接GPIO控制 */
#include <helpers/nrfx_reset_reason.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/pm/device.h>
#include <zephyr/sys/poweroff.h>

#include "interrupt_handler.h"
#include "mos_button.h"
#include "mos_lsm6dsv16x.h"
#include "mos_lvgl_display.h"
#include "mos_npm1300_ldsw.h"
#include "mos_opt3006.h"

/* External function from main.c | 来自main.c的外部函数 */
extern void configure_default_low_pins(void);
extern void vad_power_control(bool enable);
extern void ear_en_control(bool enable);

LOG_MODULE_REGISTER(mos_button_app, LOG_LEVEL_INF);

/* Button press detection parameters | 按键按下检测参数 */
#define BUTTON_LONG_PRESS_MS 2500  // Long press threshold: 2.5 seconds | 长按阈值：2.5秒
#define BUTTON_POLL_INTERVAL_MS 50  // Polling interval: 50ms | 轮询间隔：50ms
#define BUTTON_DEBOUNCE_MS 20  // Debounce time: 20ms | 消抖时间：20ms

/* Button state tracking | 按键状态跟踪 */
static bool button_app_initialized = false;
static mos_button_app_callback_t button_app_callback = NULL;
static struct k_work_delayable button_poll_work;  // 50ms定时器用于轮询按键状态 | 50ms timer for polling button state
static bool button_press_detected = false;
static int64_t button_press_start_time = 0;  // 按键按下开始时间 | Button press start time
static bool peripherals_turned_off = false;  // 外设是否已关闭 | Whether peripherals are turned off
static int64_t wakeup_button_press_time = 0;  // 唤醒时按键按下的时间（如果已按下）| Button press time on wakeup (if
                                              // already pressed)
static bool button_released_after_wakeup = false;  // 唤醒后按键是否已释放（用于判断是否可以进入休眠逻辑）| Whether
                                                   // button was released after wakeup (for sleep logic)
static bool button_was_released_before_press = false;  // 按键在当前按下前是否已释放（用于休眠逻辑）| Whether button was
                                                       // released before current press (for sleep logic)

/**
 * @brief Button polling handler | 按键轮询处理
 *
 * Called every 50ms to check button state and accumulate press time | 每50ms调用一次检查按键状态并累计按下时间
 * Logic:
 * - If button is pressed: accumulate time, if >= 2.5s, turn off peripherals
 * - If button is released:
 *   - If peripherals already turned off (>= 2.5s pressed): enter sleep
 *   - If peripherals not turned off (< 2.5s pressed): short press, cancel timer, re-enable interrupt
 * 逻辑：
 * - 如果按键按下：累计时间，如果>=2.5s，关闭外设
 * - 如果按键松开：
 *   - 如果外设已关闭（>=2.5s按下）：进入休眠
 *   - 如果外设未关闭（<2.5s按下）：短按，取消定时器，重新使能中断
 */
static void button_poll_handler(struct k_work* work)
{
    ARG_UNUSED(work);

    if (!button_press_detected)
    {
        /* Button press was cancelled or reset | 按键按下已取消或重置 */
        return;
    }

    /* Check button state using GPIO polling (interrupt is disabled) | 使用GPIO轮询检查按键状态（中断已禁用）*/
    bool is_pressed = mos_button_is_pressed();

    if (!is_pressed)
    {
        /* Button is released - check if long press was completed | 按键已释放 - 检查是否已完成长按 */
        if (peripherals_turned_off)
        {
            /* Long press completed (>= 2.5s) and button released - enter sleep | 长按已完成（>=2.5s）且按键已释放 -
             * 进入休眠 */
            LOG_INF("✅ Button released after long press (2.5s+) - entering System OFF sleep");
            button_press_detected = false;
            button_press_start_time = 0;
            peripherals_turned_off = false;
            /* Note: button_was_released_before_press will be set to true after device wakes up |
             * 注意：button_was_released_before_press将在设备唤醒后设置为true */
            mos_button_app_enter_sleep();
            /* Should not reach here | 不应该到达这里 */
            return;
        }
        else
        {
            /* Short press detected (released before 2.5s) - cancel polling, re-enable interrupt |
             * 检测到短按（在2.5s前释放）- 取消轮询，重新使能中断 */
            int64_t press_duration = k_uptime_get() - button_press_start_time;
            LOG_INF("Button short press detected (duration: %lld ms, < 2.5s) - cancelling polling, re-enabling interrupt", press_duration);
            
            /* Cancel polling timer | 取消轮询定时器 */
            k_work_cancel_delayable(&button_poll_work);

            /* Reset button state | 重置按键状态 */
            button_press_detected = false;
            button_press_start_time = 0;
            peripherals_turned_off = false;

            /* Mark button as released (for sleep logic - next press can trigger sleep) | 标记按键已释放（用于休眠逻辑 -
             * 下次按下可以触发休眠）*/
            button_was_released_before_press = true;

            /* Re-enable interrupt for next button event | 重新使能中断以便下次按键事件 */
            int ret = mos_button_re_enable_interrupt();
            if (ret != 0)
            {
                LOG_ERR("Failed to re-enable button interrupt: %d", ret);
            }

            /* Call short press callback if registered | 如果已注册，调用短按回调 */
            if (button_app_callback != NULL)
            {
                button_app_callback(MOS_BUTTON_PRESS_SHORT);
            }

            return;
        }
    }
    /* Button is still pressed - calculate press duration from interrupt time | 按键仍按下 - 计算从中断触发到现在的时长
     */
    int64_t press_duration = k_uptime_get() - button_press_start_time;
    LOG_DBG("Button polling: press_duration = %lld ms, peripherals_turned_off = %d", press_duration,
            peripherals_turned_off);

    if (press_duration >= BUTTON_LONG_PRESS_MS && !peripherals_turned_off)
    {
        LOG_INF("✅ Button long press (2.5s) detected - turning off peripherals");
        vad_power_control(false);  // Disable VAD power control | 禁用VAD电源控制
        ear_en_control(false);
        // opt3006_set_mode(OPT3006_MODE_SHUTDOWN);  // Shutdown OPT3006 | 关闭 OPT3006
        mos_npm1300_ldsw1_disable();
        opt3006_prepare_for_sleep();
        lsm6dsv16x_sleep();
        set_display_onoff(false);  // Set display state to off | 设置显示状态为关闭
        a6n_power_off();  // Turn off A6N display power | 关闭A6N显示电源
        a6n_io_off();  // Turn off A6N I/O power | 关闭A6N I/O电源
        peripherals_turned_off = true;
        LOG_INF("Peripherals turned off, waiting for button release to enter sleep");
    }

    /* Continue polling (schedule next check in 50ms) | 继续轮询（50ms后再次检查）*/
    k_work_schedule(&button_poll_work, K_MSEC(BUTTON_POLL_INTERVAL_MS));
}

/**
 * @brief Default button event handler | 默认按键事件处理函数
 *
 * Note: Long press (2500ms) = enter sleep (handled in timeout handler)
 * 注意：长按（2500ms）= 进入休眠（在超时处理函数中处理）
 * Short press = reserved for future use
 * 短按 = 保留用于其他功能
 */
static void button_default_event_handler(mos_button_press_type_t press_type)
{
    if (press_type == MOS_BUTTON_PRESS_LONG)
    {
        /* This should not be called anymore - long press is handled in timeout handler | 这不应该再被调用 -
         * 长按在超时处理函数中处理 */
        LOG_WRN("Button long press callback called (should be handled in timeout handler)");
    }
    else if (press_type == MOS_BUTTON_PRESS_SHORT)
    {
        LOG_DBG("Button short press: Reserved for future use");
        /* Short press can be used for other functions | 短按可用于其他功能 */
    }
}

/**
 * @brief Interrupt handler callback for button events | 按键事件的中断处理回调
 *
 * This is called from the interrupt processing thread context | 从中断处理线程上下文调用
 */
static void button_interrupt_callback(interrupt_event_t* event)
{
    if (event == NULL)
    {
        return;
    }

    switch (event->event)
    {
        case INTERRUPT_TYPE_BUTTON_PRESSED:
        {
            int64_t interrupt_time = k_uptime_get();
            LOG_INF("Button interrupt received - configuring for polling, starting 20ms debounce");

            int ret = mos_button_configure_for_polling();
            if (ret != 0)
            {
                LOG_ERR("Failed to configure button GPIO for polling: %d", ret);
                break;
            }
            k_sleep(K_MSEC(BUTTON_DEBOUNCE_MS));

            bool is_pressed = mos_button_is_pressed();

            if (!is_pressed)
            {
                /* Button is released after debounce - ignore as bounce | 消抖后按键已释放 - 忽略（可能是抖动）*/
                LOG_INF("Button released after debounce (20ms) - ignoring as bounce (raw GPIO = %d)", is_pressed);

                ret = mos_button_re_enable_interrupt();
                if (ret != 0)
                {
                    LOG_ERR("Failed to re-enable button interrupt: %d", ret);
                }
                break;
            }

            /* Check if button was released after wakeup (for sleep logic) | 检查唤醒后按键是否已释放（用于休眠逻辑）*/
            /* If device just woke up and button is still pressed from wakeup, ignore this press |
             * 如果设备刚唤醒且按键仍从唤醒时按下，忽略此次按下 */
            if (!button_released_after_wakeup)
            {
                LOG_INF("Button pressed but not released after wakeup yet - ignoring this press (need release first)");
                ret = mos_button_re_enable_interrupt();
                if (ret != 0)
                {
                    LOG_ERR("Failed to re-enable button interrupt: %d", ret);
                }
                break;
            }

            /* Check if button was released before this press (for sleep logic) |
             * 检查按键在当前按下前是否已释放（用于休眠逻辑）*/
            /* Only allow sleep logic if button was released before current press |
             * 只有按键在当前按下前已释放，才允许休眠逻辑 */
            if (!button_was_released_before_press)
            {
                LOG_INF("Button pressed but was not released before this press - ignoring for sleep logic");
                ret = mos_button_re_enable_interrupt();
                if (ret != 0)
                {
                    LOG_ERR("Failed to re-enable button interrupt: %d", ret);
                }
                break;
            }

            /* Initialize button press tracking | 初始化按键按下跟踪 */
            button_press_detected = true;
            button_press_start_time = interrupt_time;  // Use interrupt time as start time | 使用中断时间作为开始时间
            peripherals_turned_off = false;
            button_was_released_before_press = false;  // Reset flag | 重置标志

            k_work_schedule(&button_poll_work, K_MSEC(BUTTON_POLL_INTERVAL_MS));
        }
        break;
        default:
            LOG_WRN("Unknown button interrupt event type: %u", event->event);
            break;
    }
}

int mos_button_app_init(void)
{
    int ret;

    if (button_app_initialized)
    {
        LOG_WRN("Button app already initialized");
        return 0;
    }

    /* Initialize button driver | 初始化按键驱动 */
    ret = mos_button_init();
    if (ret != 0)
    {
        LOG_ERR("Failed to initialize button driver: %d", ret);
        return ret;
    }

    /* If not waking from sleep (normal power-on), button is considered released |
     * 如果不是从休眠唤醒（正常上电），按键被视为已释放 */
    /* Note: wakeup_button_press_time > 0 means we woke from sleep with button pressed | 注意：wakeup_button_press_time
     * > 0 表示我们从休眠唤醒时按键已按下 */
    if (wakeup_button_press_time == 0)
    {
        button_released_after_wakeup = true;
        button_was_released_before_press = true;  // Normal power-on, button is released | 正常上电，按键已释放
        LOG_INF("Normal power-on detected - button sleep logic enabled");
    }
    else
    {
        /* Waking from sleep - button_released_after_wakeup will be set in mos_button_app_wait_for_power_on() |
         * 从休眠唤醒 - button_released_after_wakeup将在mos_button_app_wait_for_power_on()中设置 */
        button_released_after_wakeup = false;
        button_was_released_before_press = false;  // Waking from sleep, button may still be pressed |
                                                   // 从休眠唤醒，按键可能仍按下
        LOG_INF("Waking from sleep - button sleep logic will be enabled after power-on confirmation");
    }

    /* Initialize work for button polling (50ms interval) | 初始化按键轮询工作（50ms间隔）*/
    k_work_init_delayable(&button_poll_work, button_poll_handler);

    /* Check if interrupt handler framework is initialized | 检查中断处理框架是否已初始化 */
    if (!interrupt_handler_is_initialized())
    {
        LOG_ERR("Interrupt handler framework not initialized. Call interrupt_handler_init() first.");
        return -ENODEV;
    }

    /* Register interrupt callbacks for button events | 为按键事件注册中断回调 */
    ret = interrupt_handler_register_callback(INTERRUPT_TYPE_BUTTON_PRESSED, button_interrupt_callback);
    if (ret != 0)
    {
        LOG_ERR("Failed to register button pressed interrupt callback: %d", ret);
        return ret;
    }

    button_app_callback = button_default_event_handler;
    LOG_INF("Default button handler registered: long press (2500ms) = enter sleep, short press = reserved");

    button_app_initialized = true;
    LOG_INF("Button application logic initialized (using interrupt handler framework)");

    return 0;
}

int mos_button_app_register_callback(mos_button_app_callback_t callback)
{
    if (callback == NULL)
    {
        return -EINVAL;
    }

    button_app_callback = callback;
    LOG_INF("Button app callback registered");
    return 0;
}

void mos_button_app_unregister_callback(void)
{
    button_app_callback = NULL;
    LOG_INF("Button app callback unregistered");
}

/**
 * @brief Prepare device for sleep - turn off all peripherals and configure wakeup | 准备设备进入休眠 -
 * 关闭所有外设并配置唤醒
 * @param turn_off_peripherals Whether to turn off peripherals (display, VAD, LDSW1) | 是否关闭外设（显示、VAD、LDSW1）
 * @return 0 on success, negative error code on failure
 * @return 成功返回0，失败返回负数错误码
 * @note This function should be called before sys_poweroff() to ensure proper sleep preparation | 此函数应在
 * sys_poweroff() 之前调用以确保正确的休眠准备
 */
static int prepare_for_sleep(bool turn_off_peripherals)
{
    int ret;

    LOG_INF("Preparing device for System OFF sleep mode...");

    /* Turn off peripherals if requested | 如果请求，关闭外设 */
    if (turn_off_peripherals)
    {
        LOG_INF("Turning off peripherals before sleep...");

        vad_power_control(false);
        ear_en_control(false);
        /* Disable LDSW1 | 禁用LDSW1 */
        
        /* Put OPT3006 into shutdown mode | 关闭 OPT3006 */
        // opt3006_set_mode(OPT3006_MODE_SHUTDOWN);
        opt3006_prepare_for_sleep();
        lsm6dsv16x_sleep();
        mos_npm1300_ldsw1_disable();
        /* Turn off display | 关闭显示 */
        set_display_onoff(false);  // Set display state to off | 设置显示状态为关闭
        a6n_power_off();  // Turn off A6N display power | 关闭A6N显示电源
        a6n_io_off();  // Turn off A6N I/O power | 关闭A6N I/O电源

        LOG_INF("All peripherals turned off");
    }
    else
    {
        vad_power_control(false);  // Disable VAD power control | 禁用VAD电源控制
    }

    /* Ensure all default LOW pins are LOW before sleep | 睡眠前确保所有默认拉低的引脚为低电平 */
    configure_default_low_pins();
    /* Configure button for System OFF wakeup | 配置按键用于System OFF唤醒 */
    ret = mos_button_configure_wakeup();
    if (ret != 0)
    {
        LOG_ERR("Failed to configure button for wakeup: %d", ret);
        return ret;
    }

    LOG_INF("Device prepared for sleep");
    return 0;
}

int mos_button_app_enter_sleep(void)
{
    int ret;

    if (!button_app_initialized)
    {
        LOG_ERR("Button app not initialized");
        return -ENODEV;
    }

    LOG_INF("Preparing to enter System OFF sleep mode...");

    /* Cancel any pending button work | 取消任何待处理的按键工作 */
    k_work_cancel_delayable(&button_poll_work);

    /* Reset button state flags | 重置按键状态标志 */
    button_press_detected = false;
    button_press_start_time = 0;
    peripherals_turned_off = false;

    /* Unregister interrupt callbacks | 注销中断回调 */
    interrupt_handler_unregister_callback(INTERRUPT_TYPE_BUTTON_PRESSED, button_interrupt_callback);
    interrupt_handler_unregister_callback(INTERRUPT_TYPE_BUTTON_RELEASED, button_interrupt_callback);

    /* Prepare for sleep - peripherals may already be off from button handler | 准备休眠 - 外设可能已在按键处理中关闭 */
    ret = prepare_for_sleep(!peripherals_turned_off);
    if (ret != 0)
    {
        LOG_ERR("Failed to prepare for sleep: %d", ret);
        return ret;
    }

    LOG_INF("Entering System OFF sleep mode...");
    LOG_INF("Press button to wake up");

    /* Enter System OFF - this will not return | 进入System OFF - 这不会返回 */
    sys_poweroff();

    /* Should never reach here | 不应该到达这里 */
    return -EIO;
}

bool mos_button_app_is_waking_from_sleep(void)
{
    uint32_t reset_reason = nrfx_reset_reason_get();

    bool gpio_wakeup = (reset_reason & NRFX_RESET_REASON_OFF_MASK) != 0;

    if (gpio_wakeup)
    {
        /* Clear reset reason | 清除复位原因 */
        nrfx_reset_reason_clear(reset_reason);
        LOG_INF("Device waking from System OFF (GPIO wakeup), reset_reason: 0x%08X", reset_reason);
        return true;
    }
    else
    {
        /* Not a GPIO wakeup - could be power-on reset or other reset | 不是GPIO唤醒 - 可能是重新上电复位或其他复位 */
        if (reset_reason != 0)
        {
            LOG_INF("Device reset detected (not GPIO wakeup), reset_reason: 0x%08X - normal startup", reset_reason);
            /* Clear reset reason for other resets too | 也清除其他复位原因 */
            nrfx_reset_reason_clear(reset_reason);
        }
        else
        {
            LOG_INF("Device power-on reset detected (reset_reason: 0) - normal startup");
        }
        return false;
    }
}

bool mos_button_app_check_wakeup_state(void)
{
    bool woke_from_sleep = mos_button_app_is_waking_from_sleep();

    if (!woke_from_sleep)
    {
        wakeup_button_press_time = 0;
        return false;
    }

    /* 检查按键是否按下，如果按下则记录时间 | Check if button is pressed, record time if pressed */
    const struct gpio_dt_spec button_gpio = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), button_gpios);

    if (!gpio_is_ready_dt(&button_gpio))
    {
        gpio_pin_configure_dt(&button_gpio, GPIO_INPUT | GPIO_PULL_UP);
        k_sleep(K_MSEC(5));
    }

    int val = gpio_pin_get(button_gpio.port, button_gpio.pin);
    if (val == 0)  // Button is active low | 按键为低电平有效
    {
        wakeup_button_press_time = k_uptime_get();
        LOG_INF("Button pressed on wakeup - recorded time: %lld ms", wakeup_button_press_time);
    }
    else
    {
        wakeup_button_press_time = 0;
    }

    return woke_from_sleep;
}

int mos_button_app_wait_for_power_on(uint32_t timeout_ms)
{
    int ret;
    bool long_press_detected = false;
    int64_t current_time = k_uptime_get();
    int64_t timeout_time = current_time + timeout_ms;
    int64_t button_press_start_time = 0;
    bool button_was_pressed = false;
    bool long_press_reached = false;  // Flag to track if 2.5s has been reached | 标志：是否已达到2.5s

    LOG_INF("Waiting for button long press (2500ms) to power on...");
    LOG_INF("Press and hold button for 2.5 seconds to start device");

    ret = mos_button_init();
    if (ret != 0)
    {
        LOG_ERR("Failed to initialize button driver: %d", ret);
        return ret;
    }

    /* Check if button was already pressed on wakeup (recorded by mos_button_app_check_wakeup_state) |
     * 检查唤醒时按键是否已按下（由mos_button_app_check_wakeup_state记录）*/
    if (wakeup_button_press_time > 0)
    {
        /* Button was already pressed on wakeup - calculate elapsed time | 唤醒时按键已按下 - 计算已过去的时间 */
        int64_t elapsed_time = current_time - wakeup_button_press_time;
        LOG_INF("Button already pressed on wakeup - elapsed time: %lld ms (recorded at %lld ms, current %lld ms)",
                elapsed_time, wakeup_button_press_time, current_time);

        /* If already pressed for 2.5s or more, power on immediately (don't wait for release) |
         * 如果已经按下2.5秒或更久，立即开机（不等待释放）*/
        if (elapsed_time >= BUTTON_LONG_PRESS_MS)
        {
            /* Already pressed for 2.5s+ - power on immediately | 已经按下2.5秒+ - 立即开机 */
            LOG_INF("Button already pressed for %lld ms (>= 2500ms) - power on confirmed immediately", elapsed_time);
            wakeup_button_press_time = 0;  // Clear wakeup time | 清除唤醒时间
            return 0;  // Success | 成功
        }
        else
        {
            /* Still need to wait for remaining time | 仍需要等待剩余时间 */
            /* Use wakeup time as start time, so press_duration calculation will be correct |
             * 使用唤醒时间作为开始时间，这样按下时长计算将是正确的 */
            button_press_start_time = wakeup_button_press_time;
            button_was_pressed = true;
            long_press_reached = false;  // Not reached 2.5s yet | 尚未达到2.5秒
            wakeup_button_press_time = 0;  // Clear wakeup time | 清除唤醒时间
            LOG_INF("Need to wait for remaining time: %lld ms (already waited %lld ms)",
                    BUTTON_LONG_PRESS_MS - elapsed_time, elapsed_time);
        }
    }
    else
    {
        /* Button was not pressed on wakeup - check current state | 唤醒时按键未按下 - 检查当前状态 */
        k_sleep(K_MSEC(10));  // Small delay for GPIO stabilization | 小延迟用于GPIO稳定

        if (!mos_button_is_pressed())
        {
            /* Button is not pressed - short press wakeup, enter sleep again | 按键未按下 - 短按唤醒，再次进入休眠 */
            LOG_INF("Button not pressed after wakeup (short press detected) - entering sleep again");

            ret = prepare_for_sleep(true);
            if (ret != 0)
            {
                LOG_ERR("Failed to prepare for sleep: %d", ret);
                return ret;
            }

            LOG_INF("Entering System OFF sleep mode (short press wakeup)...");
            sys_poweroff();
            return -EIO;
        }

        /* Button is now pressed - start timing now | 按键现在按下 - 现在开始计时 */
        LOG_INF("Button pressed after wakeup - starting long press detection");
        button_press_start_time = k_uptime_get();
        button_was_pressed = true;
        long_press_reached = false;  // Not reached 2.5s yet | 尚未达到2.5秒
    }

    while (!long_press_detected && (k_uptime_get() < timeout_time))
    {
        bool button_is_pressed = mos_button_is_pressed();
        int64_t current_time = k_uptime_get();

        if (button_is_pressed)
        {
            if (!button_was_pressed)
            {
                /* Button just pressed - record start time | 按键刚按下 - 记录开始时间 */
                button_press_start_time = current_time;
                button_was_pressed = true;
                long_press_reached = false;
                LOG_INF("Button pressed, starting long press detection (need 2.5s, then release)");
            }
            else
            {
                int64_t press_duration = current_time - button_press_start_time;

                if (press_duration >= BUTTON_LONG_PRESS_MS && !long_press_reached)
                {
                    /* Long press duration reached (2.5s) - power on immediately (don't wait for release) |
                     * 达到长按时长（2.5s）- 立即开机（不等待释放）*/
                    LOG_INF(
                        "Button long press (2500ms) reached (total duration: %lld ms) - power on confirmed immediately",
                        press_duration);
                    long_press_reached = true;
                    long_press_detected = true;  // Mark as detected, will exit loop | 标记为已检测，将退出循环
                    break;  // Exit loop immediately | 立即退出循环
                }
            }
        }
        else
        {
            if (button_was_pressed)
            {
                /* Button was released | 按键已释放 */
                int64_t press_duration = current_time - button_press_start_time;

                if (press_duration < BUTTON_LONG_PRESS_MS)
                {
                    /* Released before 2.5s - enter sleep again | 在2.5s前释放 - 再次进入休眠 */
                    LOG_INF("Button released after %lld ms (need 2500ms) - entering sleep again", press_duration);

                    /* Prepare for sleep with full peripheral shutdown (same as long press sleep) |
                     * 准备休眠并完全关闭外设（与长按休眠相同）*/
                    ret = prepare_for_sleep(true);
                    if (ret != 0)
                    {
                        LOG_ERR("Failed to prepare for sleep: %d", ret);
                        return ret;
                    }

                    LOG_INF("Entering System OFF sleep mode...");
                    sys_poweroff();
                    /* Should not reach here | 不应该到达这里 */
                    return -ETIMEDOUT;
                }
                else if (long_press_reached)
                {
                    /* Released after 2.5s - condition met! | 在2.5s后释放 - 条件满足！ */
                    LOG_INF("Button released after long press (2.5s+, total: %lld ms) - powering on device",
                            press_duration);
                    long_press_detected = true;
                    break;
                }
                else
                {
                    /* This shouldn't happen - button was pressed but long_press_reached is false | 这不应该发生 -
                     * 按键已按下但long_press_reached为false */
                    LOG_WRN("Button released but long_press_reached is false (duration: %lld ms)", press_duration);
                    button_was_pressed = false;
                    button_press_start_time = 0;
                }
            }
        }

        /* Use shorter polling interval for faster response (reduced from 50ms to 20ms) |
         * 使用更短的轮询间隔以加快响应（从50ms减少到20ms）*/
        k_sleep(K_MSEC(20));  // Check every 20ms for faster response | 每20ms检查一次以加快响应
    }

    /* If timeout reached but button is still pressed after 2.5s, power on immediately |
     * 如果超时但按键在2.5s后仍按下，立即开机 */
    if (!long_press_detected && long_press_reached)
    {
        LOG_INF("Timeout reached but button still pressed after 2.5s - powering on device immediately");
        long_press_detected = true;
    }

    if (long_press_detected)
    {
        LOG_INF("Power-on long press confirmed - device will start normally");

        /* Mark button as released after wakeup (for sleep logic) | 标记唤醒后按键已释放（用于休眠逻辑）*/
        button_released_after_wakeup = true;
        /* Note: button_was_released_before_press will be set to true when button is actually released |
         * 注意：button_was_released_before_press将在按键实际释放时设置为true */
        LOG_INF("Power-on confirmed - ready for normal operation");

        return 0;
    }
    else
    {
        LOG_WRN("Power-on long press not detected within timeout (%u ms) - entering sleep again", timeout_ms);
        return -ETIMEDOUT;
    }
}
