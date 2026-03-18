/*
 * Copyright (c) 2018 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-5-Clause
 */

/** @file
 *  @brief MentraOS Main Application
 */
#include <soc.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/hci.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/display.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/types.h>

#include "mos_ble_service.h"
#include "mos_lvgl_display.h"  // Working LVGL display integration
#include "pdm_audio_stream.h"
#include "protobuf_handler.h"
// #include "display/lcd/a6n.h"  // Working A6N driver
#include <hal/nrf_gpio.h>  // For direct GPIO access
#include <nrfx_clock.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <zephyr/irq.h>
#include <zephyr/logging/log.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/util.h>  // For ARRAY_SIZE macro

#include "interrupt_handler.h"  // Interrupt handler framework
#include "mos_button_app.h"  // Button application logic
#include "mos_dfu_progress.h"
#include "mos_fuel_gauge.h"
#include "mos_jlink_usb_switch_app.h"  // J-Link/USB switch application logic
#include "mos_lsm6dsv16x.h"  // LSM6DSV16X 6-axis IMU sensor
#include "mos_npm1300_ldsw.h"  // NPM1300 LDSW (load switch) control
#include "mos_npm1300_led.h"
#include "mos_opt3006.h"  // OPT3006 ambient light sensor
#include "mos_usb_detect.h"  // USB cable detection (polling mode)

LOG_MODULE_REGISTER(main, LOG_LEVEL_DBG);

#define STACKSIZE 2048
#define PRIORITY 7

#define DEVICE_NAME CONFIG_BT_DEVICE_NAME
#define DEVICE_NAME_LEN (sizeof(DEVICE_NAME) - 1)

static K_SEM_DEFINE(ble_init_ok, 0, 1);

static struct bt_conn* current_conn;
static struct bt_conn* auth_conn;
static struct k_work adv_work;

static uint16_t payload_mtu = 20;
static bool ble_connected = false;

static char dynamic_device_name[30];
static struct bt_data ad[] = {
    BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
    BT_DATA(BT_DATA_NAME_COMPLETE, "MENTRA_DISPLAY_", 16),
};
static struct bt_data sd[] = {
    BT_DATA_BYTES(BT_DATA_UUID128_ALL, BT_UUID_MENTRA_VAL),
};

static void setup_dynamic_advertising(void)
{
    bt_addr_le_t addr;
    size_t count = 1;

    // Get the device address
    bt_id_get(&addr, &count);

    // Create device name with MAC suffix (last 6 hex digits)
    snprintf(dynamic_device_name, sizeof(dynamic_device_name), "MENTRA_DISPLAY_%02X%02X%02X", addr.a.val[2],
             addr.a.val[1], addr.a.val[0]);

    LOG_INF("Device name: %s", dynamic_device_name);

    // Set the Bluetooth device name
    int err = bt_set_name(dynamic_device_name);
    if (err)
    {
        LOG_ERR("Failed to set device name (err %d)", err);
    }

    // Update the advertising data with the new name
    ad[1].data = (const uint8_t*)dynamic_device_name;
    ad[1].data_len = strlen(dynamic_device_name);

    // err = bt_le_adv_update_data(ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
    // if (err != 0)
    // {
    //     LOG_ERR("Failed to update adv data (err %d)", err);
    // }
}

const char* get_ble_device_name(void)
{
    return dynamic_device_name;
}

static void adv_work_handler(struct k_work* work)
{
    // Setup dynamic advertising
    setup_dynamic_advertising();
    int err = bt_le_adv_start(BT_LE_ADV_CONN_FAST_2, ad, 2, sd, 1);
    if (err)
    {
        LOG_ERR("Advertising failed to start (err %d)", err);
        return;
    }
}

static void advertising_start(void)
{
    k_work_submit(&adv_work);
}
void set_ble_connected_status(bool connected)
{
    ble_connected = connected;
}
bool get_ble_connected_status(void)
{
    return ble_connected;
}
static void connected(struct bt_conn* conn, uint8_t err)
{
    char addr[BT_ADDR_LE_STR_LEN];

    if (err)
    {
        LOG_ERR("Connection failed, err 0x%02x %s", err, bt_hci_err_to_str(err));
        return;
    }

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));
    LOG_INF("Connected %s", addr);
    set_ble_connected_status(true);
    current_conn = bt_conn_ref(conn);
}

static void disconnected(struct bt_conn* conn, uint8_t reason)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Disconnected: %s, reason 0x%02x %s", addr, reason, bt_hci_err_to_str(reason));
    set_ble_connected_status(false);
    display_show_welcome_screen(); /* 断开后自动回到欢迎界面 | Return to welcome screen on disconnect */
    if (auth_conn)
    {
        bt_conn_unref(auth_conn);
        auth_conn = NULL;
    }

    if (current_conn)
    {
        bt_conn_unref(current_conn);
        current_conn = NULL;
    }
}

static void recycled_cb(void)
{
    LOG_INF("Connection object available from previous conn. Disconnect is complete!");
    advertising_start();
}

#ifdef CONFIG_BT_NUS_SECURITY_ENABLED
static void security_changed(struct bt_conn* conn, bt_security_t level, enum bt_security_err err)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    if (!err)
    {
        LOG_INF("Security changed: %s level %u", addr, level);
    }
    else
    {
        LOG_WRN("Security failed: %s level %u err %d %s", addr, level, err, bt_security_err_to_str(err));
    }
}
#endif

BT_CONN_CB_DEFINE(conn_callbacks) = {
    .connected = connected,
    .disconnected = disconnected,
    .recycled = recycled_cb,
#ifdef CONFIG_BT_NUS_SECURITY_ENABLED
    .security_changed = security_changed,
#endif
};

#if defined(CONFIG_BT_NUS_SECURITY_ENABLED)
static void auth_passkey_display(struct bt_conn* conn, unsigned int passkey)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Passkey for %s: %06u", addr, passkey);
}

static void auth_passkey_confirm(struct bt_conn* conn, unsigned int passkey)
{
    char addr[BT_ADDR_LE_STR_LEN];

    auth_conn = bt_conn_ref(conn);

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Passkey for %s: %06u", addr, passkey);

    if (IS_ENABLED(CONFIG_SOC_SERIES_NRF54HX) || IS_ENABLED(CONFIG_SOC_SERIES_NRF54LX))
    {
        LOG_INF("Press Button 0 to confirm, Button 1 to reject.");
    }
    else
    {
        LOG_INF("Press Button 1 to confirm, Button 2 to reject.");
    }
}

static void auth_cancel(struct bt_conn* conn)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Pairing cancelled: %s", addr);
}

static void pairing_complete(struct bt_conn* conn, bool bonded)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Pairing completed: %s, bonded: %d", addr, bonded);
}

static void pairing_failed(struct bt_conn* conn, enum bt_security_err reason)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Pairing failed conn: %s, reason %d %s", addr, reason, bt_security_err_to_str(reason));
}

static struct bt_conn_auth_cb conn_auth_callbacks = {
    .passkey_display = auth_passkey_display,
    .passkey_confirm = auth_passkey_confirm,
    .cancel = auth_cancel,
};

static struct bt_conn_auth_info_cb conn_auth_info_callbacks = {.pairing_complete = pairing_complete,
                                                               .pairing_failed = pairing_failed};
#else
static struct bt_conn_auth_cb conn_auth_callbacks;
static struct bt_conn_auth_info_cb conn_auth_info_callbacks;
#endif

static void bt_receive_cb(struct bt_conn* conn, const uint8_t* const data, uint16_t len)
{
    char addr[BT_ADDR_LE_STR_LEN] = {0};

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, ARRAY_SIZE(addr));

    LOG_INF("Received data from: %s", addr);

    // Analyze the protobuf message and send to LVGL display
    protobuf_analyze_message(data, len);

    // Generate and send echo response
    uint8_t echo_buffer[128];
    int echo_len = protobuf_generate_echo_response(data, len, echo_buffer, sizeof(echo_buffer));

    if (echo_len > 0)
    {
        LOG_INF("🔄 Attempting to send echo response (%d bytes)...", echo_len);
        int err = custom_nus_send(conn, echo_buffer, echo_len);
        if (err)
        {
            LOG_ERR("❌ Failed to send echo response: %d (likely notification subscription issue)", err);
        }
        else
        {
            LOG_INF("✅ Sent echo response successfully: %s", echo_buffer);
        }
    }
    else
    {
        LOG_WRN("⚠️ No echo response generated (echo_len = %d)", echo_len);
    }
}

static struct custom_nus_cb nus_cb = {
    .received = bt_receive_cb,
};
uint16_t get_ble_payload_mtu(void)
{
    return payload_mtu;
}
void mtu_updated(struct bt_conn* conn, uint16_t tx, uint16_t rx)
{
    payload_mtu = bt_gatt_get_mtu(conn) - 3;  // 3 bytes used for Attribute headers.
    LOG_INF("Updated MTU: TX: %d RX: %d bytes", tx, rx);
    LOG_INF("Updated MTU: %d; Payload=[%d] ", payload_mtu + 3, payload_mtu);
}
static struct bt_gatt_cb gatt_callbacks = {.att_mtu_updated = mtu_updated};

/**
 * @brief ble send data function
 * @param data Pointer to the data to send
 * @param len Length of the data to send
 * @return 0 on success, -1 on failure
 */
int ble_send_data(const uint8_t* data, uint16_t len)
{
    if ((!data || len == 0) || !get_ble_connected_status())
    // if ((!data || len == 0))
    {
        // LOG_ERR("Invalid data or length || ble not connected");
        return -1;
    }
    // LOG_INF("<--Sending data to BLE-->: len=%d", len);
    // LOG_INF("Data: %s", data);
    // LOG_HEXDUMP_INF(data, len, "Hexdump:");
    uint16_t offset = 0;
    uint16_t mtu = get_ble_payload_mtu();
    while (offset < len)
    {
        uint16_t chunk_len = MIN(len - offset, mtu);
        int retry = 0;
        int err;
        do
        {
            err = custom_nus_send(NULL, &data[offset], chunk_len);
            if (err == 0)
                break;
            LOG_ERR(" Chunk send failed (offset=%u len=%u), retry %d", offset, chunk_len, retry);
        } while (++retry < 3);  // max 3 retries
        // LOG_HEXDUMP_INF( &data[offset], chunk_len, "Hexdump:");
        if (err != 0)
        {
            LOG_ERR("Final failure at offset=%u", offset);
            return -1;
        }
        offset += chunk_len;
        k_msleep(1);  // delay 2ms to avoid flooding the BLE interface
    }

    return 0;
}
void error(void)
{
    while (true)
    {
        /* Spin for ever */
        k_sleep(K_MSEC(1000));
    }
}

#ifdef CONFIG_BT_NUS_SECURITY_ENABLED
static void num_comp_reply(bool accept)
{
    if (accept)
    {
        bt_conn_auth_passkey_confirm(auth_conn);
        LOG_INF("Numeric Match, conn %p", (void*)auth_conn);
    }
    else
    {
        bt_conn_auth_cancel(auth_conn);
        LOG_INF("Numeric Reject, conn %p", (void*)auth_conn);
    }

    bt_conn_unref(auth_conn);
    auth_conn = NULL;
}
#endif /* CONFIG_BT_NUS_SECURITY_ENABLED */

/**
 * @brief Initialize user GPIOs (ES power and Microphone power)
 * @return 0 on success, negative value on error
 */
#define USER_NODE DT_PATH(zephyr_user)
static const struct gpio_dt_spec vad_power = GPIO_DT_SPEC_GET(USER_NODE, vad_power_gpios);
static const struct gpio_dt_spec int4 = GPIO_DT_SPEC_GET(USER_NODE, int4_gpios);
static const struct gpio_dt_spec ear_en = GPIO_DT_SPEC_GET(USER_NODE, ear_en_gpios);
/**
 * @brief Control VAD power on/off | 控制VAD电源开关
 * @param enable true to turn on VAD power (HIGH), false to turn off (LOW) |
 * true开启VAD电源（高电平），false关闭（低电平）
 */
void vad_power_control(bool enable)
{
    gpio_pin_set_dt(&vad_power, enable ? 1 : 0);
    LOG_INF("VAD power %s", enable ? "ON" : "OFF");
}

/**
 * @brief Control ear_en on/off | 控制 ear_en 开关
 * @param enable true to set HIGH, false to set LOW | true拉高，false拉低
 */
void ear_en_control(bool enable)
{
    gpio_pin_set_dt(&ear_en, enable ? 1 : 0);
    LOG_INF("ear_en %s", enable ? "HIGH" : "LOW");
}

/**
 * @brief Configure default LOW GPIO pins | 配置默认拉低的GPIO引脚
 * @return void
 * @note This function drives the specified pins to output LOW state | 此函数将指定的引脚驱动为输出低电平状态
 */
void configure_default_low_pins(void)
{
    /* Force specified IOs to default LOW | 强制指定IO拉低 */
    const uint32_t default_low_pins[] = {
        NRF_GPIO_PIN_MAP(1, 12), NRF_GPIO_PIN_MAP(0, 27), NRF_GPIO_PIN_MAP(0, 24), NRF_GPIO_PIN_MAP(0, 26),
        NRF_GPIO_PIN_MAP(0, 28), NRF_GPIO_PIN_MAP(0, 2),  NRF_GPIO_PIN_MAP(0, 3),  NRF_GPIO_PIN_MAP(0, 4),
    };

    for (int i = 0; i < ARRAY_SIZE(default_low_pins); i++)
    {
        nrf_gpio_cfg_output(default_low_pins[i]);
        nrf_gpio_pin_clear(default_low_pins[i]);
    }
}

int init_user_gpio(void)
{
    int err;
    const struct gpio_dt_spec* gpios[] = {
        &vad_power,
        &int4,
    };
    const char* gpio_names[] = {
        "vad_power (P1.00)",
        "int4 (P0.22)",
    };

    /* Initialize all user GPIOs as output, default LOW | 初始化所有用户GPIO为输出，默认低电平 */
    for (int i = 0; i < ARRAY_SIZE(gpios); i++)
    {
        if (!gpio_is_ready_dt(gpios[i]))
        {
            LOG_ERR("GPIO port for %s not ready", gpio_names[i]);
            return -1;
        }

        /* Configure as output, default LOW | 配置为输出，默认低电平 */
        err = gpio_pin_configure_dt(gpios[i], GPIO_OUTPUT_INACTIVE);
        if (err != 0)
        {
            LOG_ERR("%s config error: %d", gpio_names[i], err);
            return err;
        }

        /* Set to LOW (inactive) | 设置为低电平（非活动）*/
        err = gpio_pin_set_dt(gpios[i], 0);
        if (err != 0)
        {
            LOG_ERR("Failed to set %s to LOW: %d", gpio_names[i], err);
            return err;
        }

        // LOG_DBG("%s configured as output, set to LOW", gpio_names[i]);
    }
    /* ear_en: configure as output and pull HIGH | ear_en：配置为输出并拉高 */
    if (gpio_is_ready_dt(&ear_en))
    {
        err = gpio_pin_configure_dt(&ear_en, GPIO_OUTPUT_ACTIVE);
        if (err != 0)
        {
            LOG_ERR("ear_en GPIO config error: %d", err);
            return err;
        }
        ear_en_control(true);  // Ensure ear_en is HIGH
        LOG_INF("ear_en GPIO configured and set to HIGH");
    }
    else
    {
        LOG_WRN("ear_en GPIO not ready, skipping");
    }
    LOG_INF("User GPIOs configured successfully");
    return 0;
}

int main(void)
{
    int err = 0;
    LOG_INF("🚀🚀🚀 MAIN FUNCTION STARTED - v2.2.0-DISPLAY_OPEN_FIX 🚀🚀🚀");

    bool woke_from_sleep = mos_button_app_check_wakeup_state();

    err = init_user_gpio();
    if (err != 0)
    {
        LOG_ERR("Failed to initialize user GPIOs: %d", err);
    }

    vad_power_control(true);  // Enable VAD power by default | 默认启用VAD电源

    if (IS_ENABLED(CONFIG_BT_NUS_SECURITY_ENABLED))
    {
        err = bt_conn_auth_cb_register(&conn_auth_callbacks);
        if (err)
        {
            LOG_ERR("Failed to register authorization callbacks. (err: %d)", err);
            return 0;
        }

        err = bt_conn_auth_info_cb_register(&conn_auth_info_callbacks);
        if (err)
        {
            LOG_ERR("Failed to register authorization info callbacks. (err: %d)", err);
            return 0;
        }
    }

    err = bt_enable(NULL);
    if (err)
    {
        error();
    }

    LOG_INF("Bluetooth initialized");

    k_sem_give(&ble_init_ok);

    if (IS_ENABLED(CONFIG_SETTINGS))
    {
        settings_load();
    }

    err = custom_nus_init(&nus_cb);
    if (err)
    {
        LOG_ERR("Failed to initialize BLE service (err: %d)", err);
        return 0;
    }

    dfu_progress_init();

    k_work_init(&adv_work, adv_work_handler);
    advertising_start();
    bt_gatt_cb_register(&gatt_callbacks);

    /* Initialize interrupt handler framework early | 早期初始化中断处理框架 */
    interrupt_handler_init();

    /* Initialize J-Link/USB switch application | 初始化J-Link/USB切换应用 */
    mos_jlink_usb_switch_app_init();
    mos_npm1300_ldsw1_init();
    mos_npm1300_ldsw1_enable();

    /* woke_from_sleep is already set by mos_button_app_check_wakeup_state() called at the start of main() |
     * woke_from_sleep已由main()开始时调用的mos_button_app_check_wakeup_state()设置 */
    if (woke_from_sleep)
    {
        LOG_INF("Device woke from System OFF - waiting for power-on long press (2.5s)...");

        int ret = mos_button_app_wait_for_power_on(1500);

        if (ret != 0)
        {
            LOG_WRN("Power-on long press not detected - entering sleep again");
            /* Enter sleep again | 再次进入休眠 */
            mos_button_app_enter_sleep();
            /* Should not reach here | 不应该到达这里 */
        }

        LOG_INF("Power-on long press confirmed - starting device normally");
    }
    mos_button_app_init();

    pm1300_init();
    battery_monitor_auto_start();

    lvgl_display_thread();

    pdm_audio_stream_init();

    protobuf_init_ping_monitoring();

    opt3006_initialize();

    lsm6dsv16x_init();

    usb_detect_init();

    npm1300_led_init();

    for (;;)
    {
        // LOG_INF("MAIN LOOP");

        k_sleep(K_MSEC(1000));
    }
}

static int hfclock_config_and_start(void)
{
    int ret;
    /* Use this to turn on 128 MHz clock for cpu_app */
    ret = nrfx_clock_divider_set(NRF_CLOCK_DOMAIN_HFCLK, NRF_CLOCK_HFCLK_DIV_1);
    ret -= NRFX_ERROR_BASE_NUM;
    if (ret)
    {
        return ret;
    }
    nrfx_clock_hfclk_start();
    while (!nrfx_clock_hfclk_is_running())
    {
    }
    return 0;
}
SYS_INIT(hfclock_config_and_start, POST_KERNEL, 0);
