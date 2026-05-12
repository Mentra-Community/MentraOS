
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
#include "mos_display.h"  // Working LVGL display integration
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

#include "mos_gx8002.h"  // GX8002 VAD path enabled
// #include "pdm_audio_stream.h"  // PDM path disabled - using GX8002 VAD
#include "interrupt_handler.h"  // Interrupt handler framework
#include "mos_dfu_progress.h"
#include "mos_fuel_gauge.h"
#include "mos_hinge_fold.h"
#include "mos_imu.h"  // IMU component
#include "mos_iqs7211e.h"
#include "mos_jlink_usb_switch_app.h"  // J-Link/USB switch application logic
#include "mos_npm1300_ldsw.h"          // NPM1300 LDSW (load switch) control
#include "mos_npm1300_led.h"
#include "mos_opt3006.h"  // OPT3006 ambient light sensor
#include "mos_touch_app.h"
#include "mos_usb_detect.h"  // USB cable detection (polling mode)

LOG_MODULE_REGISTER(main, LOG_LEVEL_DBG);

#define STACKSIZE 2048
#define PRIORITY 7
#define TOUCH_LDSW_POWER_CYCLE_OFF_MS 20U
#define TOUCH_LDSW_POWER_STABILIZE_MS 80U

#define DEVICE_NAME CONFIG_BT_DEVICE_NAME
#define DEVICE_NAME_LEN (sizeof(DEVICE_NAME) - 1)

static K_SEM_DEFINE(ble_init_ok, 0, 1);

static struct bt_conn *current_conn;
static struct bt_conn *auth_conn;
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
    ad[1].data = (const uint8_t *)dynamic_device_name;
    ad[1].data_len = strlen(dynamic_device_name);

    // err = bt_le_adv_update_data(ad, ARRAY_SIZE(ad), sd, ARRAY_SIZE(sd));
    // if (err != 0)
    // {
    //     LOG_ERR("Failed to update adv data (err %d)", err);
    // }
}

const char *get_ble_device_name(void)
{
    return dynamic_device_name;
}

static void adv_work_handler(struct k_work *work)
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
static void connected(struct bt_conn *conn, uint8_t err)
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
    display_handle_bt_connected();
    current_conn = bt_conn_ref(conn);
}

static void disconnected(struct bt_conn *conn, uint8_t reason)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Disconnected: %s, reason 0x%02x %s", addr, reason, bt_hci_err_to_str(reason));

    bool was_connected = get_ble_connected_status();
    set_ble_connected_status(false);
    if (was_connected)
    {
        display_handle_bt_disconnected();
    }
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
static void security_changed(struct bt_conn *conn, bt_security_t level, enum bt_security_err err)
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
void on_le_param_updated(struct bt_conn *conn,
						 uint16_t interval,
						 uint16_t latency,
						 uint16_t timeout)
{
	double connection_interval = interval * 1.25; // in ms
	uint16_t supervision_timeout = timeout * 10;  // in ms
	LOG_INF("on_le_param_updated -> Connection parameters updated: interval %.2f ms, latency %d intervals, timeout %d ms",
			connection_interval, latency, supervision_timeout);
}
void on_le_phy_updated(struct bt_conn *conn, struct bt_conn_le_phy_info *param)
{
	if (param->tx_phy == BT_CONN_LE_TX_POWER_PHY_1M)
	{
		LOG_INF("PHY updated. New PHY: 1M");
	}
	else if (param->tx_phy == BT_CONN_LE_TX_POWER_PHY_2M)
	{
		LOG_INF("PHY updated. New PHY: 2M");
	}
	else if (param->tx_phy == BT_CONN_LE_TX_POWER_PHY_CODED_S8)
	{
		LOG_INF("PHY updated. New PHY: Long Range");
	}
}
void on_le_data_len_updated(struct bt_conn *conn, struct bt_conn_le_data_len_info *info)
{
	uint16_t tx_len = info->tx_max_len;
	uint16_t tx_time = info->tx_max_time;
	uint16_t rx_len = info->rx_max_len;
	uint16_t rx_time = info->rx_max_time;
	LOG_INF("Data length updated. Length %d/%d bytes, time %d/%d us", tx_len, rx_len, tx_time, rx_time);
}
BT_CONN_CB_DEFINE(conn_callbacks) = {
    .connected = connected,
    .disconnected = disconnected,
    .recycled = recycled_cb,
    .le_param_updated = on_le_param_updated,
    .le_phy_updated = on_le_phy_updated,
    .le_data_len_updated = on_le_data_len_updated,
#ifdef CONFIG_BT_NUS_SECURITY_ENABLED
    .security_changed = security_changed,
#endif
};

#if defined(CONFIG_BT_NUS_SECURITY_ENABLED)
static void auth_passkey_display(struct bt_conn *conn, unsigned int passkey)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Passkey for %s: %06u", addr, passkey);
}

static void auth_passkey_confirm(struct bt_conn *conn, unsigned int passkey)
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

static void auth_cancel(struct bt_conn *conn)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Pairing cancelled: %s", addr);
}

static void pairing_complete(struct bt_conn *conn, bool bonded)
{
    char addr[BT_ADDR_LE_STR_LEN];

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, sizeof(addr));

    LOG_INF("Pairing completed: %s, bonded: %d", addr, bonded);
}

static void pairing_failed(struct bt_conn *conn, enum bt_security_err reason)
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

static void bt_receive_cb(struct bt_conn *conn, const uint8_t *const data, uint16_t len)
{
    char addr[BT_ADDR_LE_STR_LEN] = {0};

    bt_addr_le_to_str(bt_conn_get_dst(conn), addr, ARRAY_SIZE(addr));

    LOG_INF("Received data from: %s", addr);

    // Analyze the protobuf message and send to LVGL display
    protobuf_analyze_message(data, len);

    // Generate and send echo response
    static uint8_t echo_buffer[251];
    memset(echo_buffer, 0, sizeof(echo_buffer));
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
void mtu_updated(struct bt_conn *conn, uint16_t tx, uint16_t rx)
{
    payload_mtu = bt_gatt_get_mtu(conn) - 3;  // 3 bytes used for Attribute headers.
    LOG_INF("Updated MTU: TX: %d RX: %d bytes", tx, rx);
    LOG_INF("Updated MTU: %d; Payload=[%d] ", payload_mtu + 3, payload_mtu);
}
static struct bt_gatt_cb gatt_callbacks = {
    .att_mtu_updated = mtu_updated
};

/**
 * @brief ble send data function
 * @param data Pointer to the data to send
 * @param len Length of the data to send
 * @return 0 on success, -1 on failure
 */
int ble_send_data(const uint8_t *data, uint16_t len)
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
            /* Send on active link to avoid notify-all ambiguity */
            err = custom_nus_send(current_conn, &data[offset], chunk_len);
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
        LOG_INF("Numeric Match, conn %p", (void *)auth_conn);
    }
    else
    {
        bt_conn_auth_cancel(auth_conn);
        LOG_INF("Numeric Reject, conn %p", (void *)auth_conn);
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
#if DT_NODE_HAS_PROP(USER_NODE, vad_power_gpios)
static const struct gpio_dt_spec mic_power = GPIO_DT_SPEC_GET(USER_NODE, vad_power_gpios);
#define MIC_POWER_GPIO_AVAILABLE 1
#else
#define MIC_POWER_GPIO_AVAILABLE 0
#endif

void mic_power_control(bool enable)
{
#if MIC_POWER_GPIO_AVAILABLE
    if (gpio_is_ready_dt(&mic_power))
    {
        int err = gpio_pin_set_dt(&mic_power, enable ? 1 : 0);
        if (err != 0)
        {
            LOG_ERR("mic_power GPIO set %s failed: %d", enable ? "HIGH" : "LOW", err);
            return;
        }

        LOG_INF("mic_power %s (physical %s)", enable ? "ENABLED" : "DISABLED", enable ? "HIGH" : "LOW");
    }
#else
    ARG_UNUSED(enable);
#endif
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
        NRF_GPIO_PIN_MAP(1, 12),
        NRF_GPIO_PIN_MAP(0, 27),
        NRF_GPIO_PIN_MAP(0, 24),
        NRF_GPIO_PIN_MAP(0, 26),
        NRF_GPIO_PIN_MAP(0, 28),
        NRF_GPIO_PIN_MAP(0, 2),
        NRF_GPIO_PIN_MAP(0, 3),
        NRF_GPIO_PIN_MAP(0, 4),
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
    /* Mic power rail enable for both VAD and PDM paths */
    if (MIC_POWER_GPIO_AVAILABLE && gpio_is_ready_dt(&mic_power))
    {
        err = gpio_pin_configure_dt(&mic_power, GPIO_OUTPUT_ACTIVE);
        if (err != 0)
        {
            LOG_ERR("mic_power GPIO config error: %d", err);
            return err;
        }
        err = gpio_pin_set_dt(&mic_power, 1);
        if (err != 0)
        {
            LOG_ERR("mic_power GPIO set HIGH failed: %d", err);
            return err;
        }
        LOG_INF("mic_power GPIO configured and set to HIGH");
    }
    else
    {
        LOG_WRN("mic_power GPIO not ready/available, skipping");
    }

    /* PDM path disabled - set CLK(P0.20) and DIN(P0.21) to default GPIO state (input, no pull) */
    nrf_gpio_cfg_default(NRF_GPIO_PIN_MAP(0, 20));
    nrf_gpio_cfg_default(NRF_GPIO_PIN_MAP(0, 21));
    LOG_INF("PDM IOs (P0.20/P0.21) set to default input state");

    LOG_INF("User GPIOs configured successfully");
    return 0;
}

static int touch_power_cycle_ldsw1(void)
{
    int ret = mos_npm1300_ldsw1_init();
    if (ret != 0)
    {
        LOG_ERR("Failed to initialize LDSW1 for touch power cycle: %d", ret);
        return ret;
    }

    ret = mos_npm1300_ldsw1_disable();
    if (ret != 0)
    {
        LOG_ERR("Failed to disable LDSW1 for touch power cycle: %d", ret);
        return ret;
    }

    k_sleep(K_MSEC(TOUCH_LDSW_POWER_CYCLE_OFF_MS));

    ret = mos_npm1300_ldsw1_enable();
    if (ret != 0)
    {
        LOG_ERR("Failed to enable LDSW1 after touch power cycle: %d", ret);
        return ret;
    }

    k_sleep(K_MSEC(TOUCH_LDSW_POWER_STABILIZE_MS));
    LOG_INF("Touch LDSW1 power cycled after reset");
    return 0;
}

int main(void)
{
    int err = 0;
    LOG_INF("🚀🚀🚀 MAIN FUNCTION STARTED - v2.2.0-DISPLAY_OPEN_FIX 🚀🚀🚀");

    err = init_user_gpio();
    if (err != 0)
    {
        LOG_ERR("Failed to initialize user GPIOs: %d", err);
    }

    err = touch_power_cycle_ldsw1();
    if (err != 0)
    {
        LOG_ERR("Touch LDSW1 power cycle failed: %d", err);
    }

    /* Bring touch online before slower display/VAD/sensor init so the first user touch after power-on is handled. */
    err = mos_touch_app_init();
    if (err != 0)
    {
        LOG_ERR("mos_touch_app_init failed: %d", err);
    }

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

    interrupt_handler_init();
    mos_gx8002_init();  // GX8002 VAD path enabled
    // pdm_audio_stream_init();  // PDM path disabled - using GX8002 VAD
    mos_jlink_usb_switch_app_init();

    pm1300_init();
    battery_monitor_auto_start();

    lvgl_display_thread();

    /* GX8002 VAD + LC3 stream initialized above; phone MicState toggles via vad_interrupt_handler. */
    protobuf_init_ping_monitoring();

    opt3006_initialize();

    mos_imu_init();

    // err = mos_hinge_fold_service_start(NULL);
    // if (err)
    // {
    //     LOG_ERR("Failed to start hinge fold service (err: %d)", err);
    // }

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
