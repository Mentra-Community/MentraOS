/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-08-22 11:02:33
 * @FilePath     : task_process.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "task_process.h"

#include <debug/cpu_load.h>
#include <hal/nrf_power.h>
#include <helpers/nrfx_gppi.h>
#include <nrfx_timer.h>

#include "bal_os.h"
#include "bspal_icm42688p.h"
#include "hls12vga.h"
#include "mos_fuel_gauge.h"
#include "mos_lvgl_display.h"
// #include "bspal_ict_15318.h"
#include <zephyr/logging/log.h>

#include "bspal_gx8002.h"
#include "bspal_jsa_1147.h"
#define LOG_MODULE_NAME TASK_PROCESS
LOG_MODULE_REGISTER(LOG_MODULE_NAME);
#define TASK_PROCESS_THREAD_STACK_SIZE (4096)
#define TASK_PROCESS_THREAD_PRIORITY   5
K_THREAD_STACK_DEFINE(task_process_stack_area, TASK_PROCESS_THREAD_STACK_SIZE);
static struct k_thread task_process_thread_data;
k_tid_t                task_process_thread_handle;

#define TASK_NAME "TASK_PROCESS"

const struct device *display_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_display));

#ifdef DPPI_PRESENT
#include <nrfx_dppi.h>

static void timer_handler(nrf_timer_event_t event_type, void *context)
{
    /*empty*/
}
#endif

void test_cpu_load(void)
{
    int      err;
    uint32_t load;
#ifdef DPPI_PRESENT
    static nrfx_timer_t timer          = NRFX_TIMER_INSTANCE(1);
    uint32_t            base_frequency = NRF_TIMER_BASE_FREQUENCY_GET(timer.p_reg);
    nrfx_timer_config_t config         = NRFX_TIMER_DEFAULT_CONFIG(base_frequency);
    uint8_t             ch;
    uint32_t            evt = nrf_power_event_address_get(NRF_POWER, NRF_POWER_EVENT_SLEEPENTER);
    uint32_t            tsk = nrfx_timer_task_address_get(&timer, NRF_TIMER_TASK_COUNT);

    config.frequency = NRFX_MHZ_TO_HZ(1);
    config.bit_width = NRF_TIMER_BIT_WIDTH_32;

    nrfx_dppi_t dppi = NRFX_DPPI_INSTANCE(0);

    err = nrfx_timer_init(&timer, &config, timer_handler);
    if (err != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx_timer_init failed: %d", err - NRFX_SUCCESS);
        return;
    }
    err = nrfx_dppi_channel_alloc(&dppi, &ch);
    if (err != NRFX_SUCCESS)
    {
        LOG_ERR("nrfx_dppi_channel_alloc failed: %d", err - NRFX_SUCCESS);
        return;
    }

    nrfx_gppi_channel_endpoints_setup(ch, evt, tsk);
    nrfx_gppi_channels_enable(BIT(ch));

    if (!IS_ENABLED(CONFIG_CPU_LOAD_USE_SHARED_DPPI_CHANNELS))
    {
        err = cpu_load_init();
        if (err != NRFX_SUCCESS)
        {
            LOG_ERR("cpu_load_init failed: %d", err - NRFX_SUCCESS);
        }
        nrfx_gppi_channels_disable(BIT(ch));
        nrfx_gppi_event_endpoint_clear(ch, evt);
        nrfx_gppi_task_endpoint_clear(ch, tsk);
        err = nrfx_dppi_channel_free(&dppi, ch);
    }
#endif
    err = cpu_load_init();
    if (err != 0)
    {
        LOG_ERR("cpu_load_init failed: %d", err);
        return;
    }

    /* Busy wait for 10 ms */
    // k_busy_wait(10000);

    // load = cpu_load_get();
    // LOG_INF( "Unexpected load:%d", load);

    // k_sleep(K_MSEC(10));
    // load = cpu_load_get();
    // LOG_INF("Unexpected load:%d", load);

    // cpu_load_reset();
    // k_sleep(K_MSEC(10));
    // load = cpu_load_get();
    // LOG_INF("Unexpected load:%d", load);
}

void task_process(void *p1, void *p2, void *p3)
{
    LOG_INF("task_process start");

    uint32_t cnt = 0;
    uint32_t load;
    // littlefs_test();
    test_cpu_load();
    bspal_icm42688p_parameter_config();
    bspal_jsa_1147_init();
    while (1)
    {
        mos_delay_ms(300);

        jsa_1147_test();
        batter_monitor();
        test_icm42688p();
        // test_ict_15318();
        load = cpu_load_get();
        LOG_INF("cpu_load_get:%d.%03d", load / 1000, load % 1000);
        cnt++;
        //if (cnt == 20)
        //{
            // gx8002_reset();
            // gx8002_get_mic_state();
        //}
        // if (cnt == 10)
        // {
        //     LOG_INF("display close");
        //     display_close();
        // }
        // else if (cnt == 20)
        // {
        //     LOG_INF("display open");
        //     display_open();
        // }
        // if (cnt == 10)
        // {
        //      hls12vga_set_brightness(0); // set brightness
        // }
        // else if (cnt == 20)
        // {
        //     cnt = 0;
        //     hls12vga_set_brightness(9); // set brightness
        // }
    }
}
void task_process_thread(void)
{
    task_process_thread_handle = k_thread_create(&task_process_thread_data, task_process_stack_area,
                                                 K_THREAD_STACK_SIZEOF(task_process_stack_area), task_process, NULL,
                                                 NULL, NULL, TASK_PROCESS_THREAD_PRIORITY, 0, MOS_OS_NO_WAIT);
    k_thread_name_set(task_process_thread_handle, TASK_NAME);
}
