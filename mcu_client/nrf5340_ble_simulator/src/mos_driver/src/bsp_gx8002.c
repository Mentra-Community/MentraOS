/*
 * @Author       : Cole
 * @Date         : 2025-12-03 11:28:03
 * @LastEditTime : 2025-12-06 15:08:59
 * @FilePath     : bsp_gx8002.c
 * @Description  :
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include "bsp_gx8002.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

// VAD interrupt handler is in separate module (vad_interrupt_handler.c)
#include "vad_interrupt_handler.h"

// Forward declaration
static void gx8002_vad_int_isr(const struct device* dev, struct gpio_callback* cb, uint32_t pins);

LOG_MODULE_REGISTER(BSP_GX8002, LOG_LEVEL_INF);

// I2C1 device from device tree for GX8002 communication
#if DT_NODE_EXISTS(DT_NODELABEL(i2c1))
#define I2C1_AVAILABLE 1
static const struct device* i2c1_dev = DEVICE_DT_GET(DT_NODELABEL(i2c1));
#else
#define I2C1_AVAILABLE 0
static const struct device* i2c1_dev = NULL;
#endif

// GX8002 power control GPIO from device tree (zephyr,user node)
#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), gx8002_power_gpios)
#define GX8002_POWER_GPIO_AVAILABLE 1
static const struct gpio_dt_spec gx8002_power = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), gx8002_power_gpios);
#else
#define GX8002_POWER_GPIO_AVAILABLE 0
LOG_ERR("GX8002 power GPIO not configured in device tree");
#endif

// VAD interrupt GPIO from device tree (zephyr,user node)
#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), gx8002_vad_int_gpios)
#define GX8002_VAD_INT_GPIO_AVAILABLE 1
static const struct gpio_dt_spec gx8002_vad_int = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), gx8002_vad_int_gpios);
#else
#define GX8002_VAD_INT_GPIO_AVAILABLE 0
#endif

// VAD interrupt callback data
static struct gpio_callback gx8002_vad_int_cb_data;

// VAD initialization logic GPIO (P0.27) from device tree
#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), vad_init_logic_gpios)
#define VAD_INIT_LOGIC_GPIO_AVAILABLE 1
static const struct gpio_dt_spec vad_init_logic = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), vad_init_logic_gpios);
#else
#define VAD_INIT_LOGIC_GPIO_AVAILABLE 0
#endif

#define GX_DATA_ADDR 0x36
#define GX_CMD_ADDR  0x2F

// I2C initialization state
static bool gx8002_i2c_initialized = false;

// I2S enable state - tracks if I2S is enabled via enable_i2s command
static bool gx8002_i2s_enabled = false;

// Initialize I2C1 device for GX8002 (only once)
static int gx8002_i2c_init(void)
{
    // Check if already initialized
    if (gx8002_i2c_initialized)
    {
        return 0;
    }

    if (!I2C1_AVAILABLE)
    {
        LOG_ERR("I2C1 not available in device tree");
        return -ENODEV;
    }

    if (!device_is_ready(i2c1_dev))
    {
        LOG_ERR("I2C1 device not ready");
        return -ENODEV;
    }

    // Configure I2C for standard speed (100kHz) - suitable for GX8002
    uint32_t i2c_cfg = I2C_SPEED_SET(I2C_SPEED_STANDARD) | I2C_MODE_CONTROLLER;
    int      ret     = i2c_configure(i2c1_dev, i2c_cfg);
    if (ret != 0)
    {
        LOG_ERR("I2C1 configure failed: %d", ret);
        return ret;
    }

    gx8002_i2c_initialized = true;
    LOG_INF("I2C1 initialized for GX8002 (address: 0x%02X)", GX_CMD_ADDR);
    return 0;
}

// I2C write data function using i2c1 device
uint8_t bsp_gx8002_iic_write_data(uint8_t slave_address, uint8_t* buf, int buf_len)
{
    if (buf_len > 511)
    {
        LOG_ERR("iic_write_data buffer overflow, buf_len=%d > 511", buf_len);
        return 0;
    }

    if (!I2C1_AVAILABLE || !device_is_ready(i2c1_dev))
    {
        LOG_ERR("I2C1 device not ready");
        return 0;
    }

    // Write data to GX8002 (command address 0x2F or data address 0x36)
    int ret = i2c_write(i2c1_dev, buf, buf_len, slave_address);
    if (ret != 0)
    {
        LOG_ERR("I2C write to 0x%02X failed: %d", slave_address, ret);
        return 0;
    }

    return 1;
}

// I2C read data function using i2c1 device
uint8_t bsp_gx8002_iic_read_data(uint8_t slave_address, uint8_t reg, uint8_t* data)
{
    if (!I2C1_AVAILABLE || !device_is_ready(i2c1_dev))
    {
        LOG_ERR("I2C1 device not ready");
        return 0;
    }

    // Read register from GX8002
    int ret = i2c_write_read(i2c1_dev, slave_address, &reg, 1, data, 1);
    if (ret != 0)
    {
        LOG_ERR("I2C read reg 0x%02X from 0x%02X failed: %d", reg, slave_address, ret);
        return 0;
    }

    return 1;
}

// Wait for reply from slave register
uint8_t bsp_gx8002_iic_wait_reply(uint8_t slave_address, uint8_t reg, uint8_t reply, int timeout_ms)
{
    int count = timeout_ms;

    while (count > 0)
    {
        uint8_t data = 0;
        if (bsp_gx8002_iic_read_data(slave_address, reg, &data))
        {
            if (data == reply)
            {
                LOG_INF("iic_wait_reply success, reg=0x%x, reply=0x%x", reg, data);
                return 1;
            }
        }
        count--;
        k_sleep(K_MSEC(1));
    }

    LOG_ERR("iic_wait_reply timeout, reg=0x%x, expect=0x%x", reg, reply);
    return 0;
}

// GX8002 firmware reset: power off 100ms then power on
static void gx8002_fm_reset(void)
{
    LOG_INF("vad reset GX8002");

    if (!GX8002_POWER_GPIO_AVAILABLE)
    {
        LOG_ERR("GX8002 power GPIO not available");
        return;
    }

    if (!gpio_is_ready_dt(&gx8002_power))
    {
        LOG_ERR("GX8002 power GPIO not ready");
        return;
    }

    int ret = gpio_pin_configure_dt(&gx8002_power, GPIO_OUTPUT);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure power GPIO: %d", ret);
        return;
    }

    ret = gpio_pin_set_dt(&gx8002_power, 0);
    if (ret != 0)
    {
        LOG_ERR("Failed to set power GPIO low: %d", ret);
        return;
    }

    k_sleep(K_MSEC(2000));

    ret = gpio_pin_set_dt(&gx8002_power, 1);
    if (ret != 0)
    {
        LOG_ERR("Failed to set power GPIO high: %d", ret);
        return;
    }

    LOG_INF("GX8002 reset completed");
}

// Get GX8002 firmware version, returns 1 on success, 0 on failure
static uint8_t gx8002_getversion(uint8_t* version)
{
    uint8_t wbuffer[2]  = {0};
    uint8_t ver_regs[4] = {0xA0, 0xA4, 0xA8, 0xAC};

    wbuffer[0] = 0xc4;
    wbuffer[1] = 0x68;

    LOG_INF("vad getversion start ...");

    // Send version query command
    uint8_t ret = bsp_gx8002_iic_write_data(GX_CMD_ADDR, wbuffer, 2);
    if (ret)
    {
        // Wait for chip to process the command (reduced from 1000ms to 200ms)
        k_sleep(K_MSEC(200));

        for (uint8_t i = 0; i < 4; i++)
        {
            ret = bsp_gx8002_iic_read_data(GX_CMD_ADDR, ver_regs[i], &version[i]);
            if (!ret)
            {
                LOG_ERR("vad getversion version fail");
                return ret;
            }
        }

        LOG_INF("vad getversion version=%d.%d.%d.%d", version[0], version[1], version[2], version[3]);
    }
    else
    {
        LOG_ERR("vad getversion version fail2");
    }

    return ret;
}

// GX8002 handshake - I2C address is fixed at 0x36 by hardware
static uint8_t gx8002_handshake(void)
{
    uint8_t wbuffer[8] = {0};
    int     try_count  = 5000;

    LOG_INF("vad handshake start ... (I2C address: 0x36)");

    while (try_count > 0)
    {
        wbuffer[0] = 0xEF;
        if (bsp_gx8002_iic_write_data(GX_DATA_ADDR, wbuffer, 1))
        {
            if (bsp_gx8002_iic_wait_reply(GX_CMD_ADDR, 0xA0, 0x78, 10))
            {
                LOG_INF("vad handshake success!");
                return 1;
            }
        }
        try_count--;
        k_sleep(K_MSEC(1));
    }

    LOG_ERR("vad handshake error, please check I2C address is 0x36");
    return 0;
}

// Initialize GX8002 power GPIO (P0.04) to high level
static int gx8002_power_gpio_init(void)
{
    if (!GX8002_POWER_GPIO_AVAILABLE)
    {
        LOG_ERR("GX8002 power GPIO not available");
        return -ENODEV;
    }

    if (!gpio_is_ready_dt(&gx8002_power))
    {
        LOG_ERR("GX8002 power GPIO not ready");
        return -ENODEV;
    }

    // Configure GPIO as output
    int ret = gpio_pin_configure_dt(&gx8002_power, GPIO_OUTPUT);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure power GPIO: %d", ret);
        return ret;
    }

    // Set to high level (power on)
    ret = gpio_pin_set_dt(&gx8002_power, 1);
    if (ret != 0)
    {
        LOG_ERR("Failed to set power GPIO high: %d", ret);
        return ret;
    }

    LOG_INF("GX8002 power GPIO (P0.04) initialized to HIGH");
    return 0;
}

static void gx8002_vad_int_isr(const struct device* dev, struct gpio_callback* cb, uint32_t pins)
{
    bsp_gx8002_vad_int_disable();
    // LOG_DBG("GX8002 VAD interrupt ISR triggered");
    int ret = vad_interrupt_handler_send_event();
    if (ret != 0)
    {
        LOG_ERR("Failed to send VAD interrupt event");
    }
}

// Initialize VAD initialization logic GPIO (P0.25)
int vad_init_logic_gpio_init(void)
{
    if (!VAD_INIT_LOGIC_GPIO_AVAILABLE)
    {
        LOG_WRN("VAD init logic GPIO not configured in device tree");
        return -ENODEV;
    }

    // Check if GPIO device pointer is valid before calling gpio_is_ready_dt
    if (vad_init_logic.port == NULL)
    {
        LOG_ERR("VAD init logic GPIO device pointer is NULL");
        return -ENODEV;
    }

    // Check if GPIO device is ready (this may hang if device is not initialized)
    if (!device_is_ready(vad_init_logic.port))
    {
        LOG_ERR("VAD init logic GPIO device not ready");
        return -ENODEV;
    }

    // Configure GPIO as output, initialize to LOW (inactive)
    // GPIO_OUTPUT_INACTIVE means logical 0 (LOW) initially
    int ret = gpio_pin_configure_dt(&vad_init_logic, GPIO_OUTPUT_INACTIVE);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure VAD init logic GPIO as output: %d", ret);
        return ret;
    }

    return 0;
}

// Set VAD initialization logic GPIO to HIGH (VAD initialization started)
void vad_init_logic_set_high(void)
{
    if (!VAD_INIT_LOGIC_GPIO_AVAILABLE)
    {
        LOG_ERR("❌ VAD init logic GPIO not available");
        return;
    }

    if (vad_init_logic.port == NULL)
    {
        LOG_ERR("VAD init logic GPIO device pointer is NULL");
        return;
    }

    if (!device_is_ready(vad_init_logic.port))
    {
        LOG_ERR("VAD init logic GPIO device not ready");
        return;
    }

    int ret = gpio_pin_set_dt(&vad_init_logic, 1);
    if (ret != 0)
    {
        LOG_ERR("Failed to set VAD init logic GPIO HIGH: %d", ret);
    }
}

// Set VAD initialization logic GPIO to LOW (VAD initialization ended)
static void vad_init_logic_set_low(void)
{
    if (!VAD_INIT_LOGIC_GPIO_AVAILABLE)
    {
        LOG_ERR("❌ VAD init logic GPIO not available");
        return;
    }

    if (vad_init_logic.port == NULL)
    {
        LOG_ERR("VAD init logic GPIO device pointer is NULL");
        return;
    }

    if (!device_is_ready(vad_init_logic.port))
    {
        LOG_ERR("VAD init logic GPIO device not ready");
        return;
    }

    int ret = gpio_pin_set_dt(&vad_init_logic, 0);
    if (ret != 0)
    {
        LOG_ERR("Failed to set VAD init logic GPIO LOW: %d", ret);
    }
}

// Initialize VAD interrupt GPIO and register callback
static int gx8002_vad_int_init(void)
{
    if (!GX8002_VAD_INT_GPIO_AVAILABLE)
    {
        LOG_ERR("GX8002 VAD interrupt GPIO not configured in device tree");
        return -ENODEV;
    }

    if (!gpio_is_ready_dt(&gx8002_vad_int))
    {
        LOG_ERR("GX8002 VAD interrupt GPIO not ready");
        return -ENODEV;
    }

    // Configure GPIO as input with pull-up
    int ret = gpio_pin_configure_dt(&gx8002_vad_int, GPIO_INPUT | GPIO_PULL_UP);
    if (ret != 0)
    {
        LOG_ERR("Failed to configure VAD interrupt GPIO: %d", ret);
        return ret;
    }

    gpio_init_callback(&gx8002_vad_int_cb_data, gx8002_vad_int_isr, BIT(gx8002_vad_int.pin));
    ret = gpio_add_callback(gx8002_vad_int.port, &gx8002_vad_int_cb_data);
    if (ret != 0)
    {
        LOG_ERR("Failed to add VAD interrupt callback: %d", ret);
        return ret;
    }
    ret = bsp_gx8002_vad_int_re_enable();
    if (ret != 0)
    {
        LOG_ERR("Failed to configure VAD interrupt: %d", ret);
        return ret;
    }
    LOG_INF("✅ VAD interrupt GPIO configured (P0.12, falling edge)");
    return 0;
}

// Re-enable VAD interrupt after processing (called from interrupt handler thread)
int bsp_gx8002_vad_int_re_enable(void)
{
    if (!GX8002_VAD_INT_GPIO_AVAILABLE)
    {
        return -ENODEV;
    }

    int ret = gpio_pin_interrupt_configure_dt(&gx8002_vad_int, GPIO_INT_EDGE_FALLING);
    if (ret != 0)
    {
        LOG_ERR("Failed to re-enable VAD interrupt: %d", ret);
        return ret;
    }

    return 0;
}

// Disable VAD interrupt (used during firmware update to prevent I2C conflicts)
int bsp_gx8002_vad_int_disable(void)
{
    if (!GX8002_VAD_INT_GPIO_AVAILABLE)
    {
        return -ENODEV;
    }
    
    int ret = gpio_pin_interrupt_configure_dt(&gx8002_vad_int, GPIO_INT_DISABLE);
    if (ret != 0)
    {
        LOG_ERR("Failed to disable VAD interrupt: %d", ret);
        return ret;
    }
    return 0;
}

// Public API implementation
int bsp_gx8002_init(void)
{
    int ret = vad_init_logic_gpio_init();
    if (ret != 0)
    {
        LOG_WRN("Failed to initialize VAD init logic GPIO, continuing anyway: %d", ret);
    }
    else
    {
        // Set VAD init logic GPIO to HIGH (VAD initialization started)
        vad_init_logic_set_high();
    }
    // Initialize power GPIO first (set to high level)
    ret = gx8002_power_gpio_init();
    if (ret != 0)
    {
        LOG_WRN("Failed to initialize power GPIO, continuing anyway");
    }

    // Initialize I2C
    ret = gx8002_i2c_init();
    if (ret != 0)
    {
        vad_init_logic_set_low();  // Set to LOW on failure
        return ret;
    }

    ret = vad_interrupt_handler_init();
    if (ret != 0)
    {
        LOG_WRN("Failed to initialize VAD interrupt handler thread, continuing anyway: %d", ret);
    }

    ret = gx8002_vad_int_init();
    if (ret != 0)
    {
        LOG_WRN("Failed to initialize VAD interrupt GPIO, continuing anyway: %d", ret);
    }

    // Set VAD init logic GPIO to LOW (VAD initialization ended)
    vad_init_logic_set_low();

    return 0;
}

void bsp_gx8002_reset(void)
{
    gx8002_fm_reset();
}

uint8_t bsp_gx8002_getversion(uint8_t* version)
{
    return gx8002_getversion(version);
}

uint8_t bsp_gx8002_handshake(void)
{
    return gx8002_handshake();
}

// Start GX8002 I2S audio output
// This function performs a complete initialization sequence to start GX8002 I2S output
// Sequence: Reset -> Handshake -> Enable I2S (write 0x71 to 0xC4)
uint8_t bsp_gx8002_start_i2s(void)
{
    LOG_INF("Starting GX8002 I2S output...");
    LOG_INF("Step 1: Resetting GX8002...");

    // Step 1: Reset GX8002 to ensure clean state
    bsp_gx8002_reset();
    k_sleep(K_MSEC(100));  // Wait for reset to complete

    LOG_INF("Step 2: Performing handshake...");

    // Step 2: Perform handshake - this is typically required before I2S works
    if (!bsp_gx8002_handshake())
    {
        LOG_ERR("GX8002 handshake failed!");
        LOG_ERR("I2S output may not work without successful handshake");
        LOG_WRN("Continuing anyway, but I2S may not be active");
        return 0;  // Return failure if handshake fails
    }

    LOG_INF("Step 3: Enabling I2S output (write 0x71 to 0xC4)...");

    // Step 3: Enable I2S output by writing 0x71 to register 0xC4
    if (!bsp_gx8002_enable_i2s())
    {
        LOG_ERR("Failed to enable GX8002 I2S output!");
        return 0;
    }

    LOG_INF("✅ GX8002 I2S output initialization complete!");
    LOG_INF("💡 GX8002 should now be sending I2S clocks (SCK, LRCK) on I2S pins");
    LOG_INF("💡 Expected I2S signals:");
    LOG_INF("   - SCK (Bit Clock) on I2S pin");
    LOG_INF("   - LRCK (Frame Clock) on I2S pin");
    LOG_INF("   - SDIN (Serial Data) on I2S pin");
    LOG_INF("💡 nRF5340 (I2S slave) should now receive data");
    LOG_INF("💡 If timeout warnings persist, check:");
    LOG_INF("   - I2S pin connections between GX8002 and nRF5340");
    LOG_INF("   - GX8002 power supply");
    LOG_INF("   - GX8002 firmware version (may need specific version for I2S)");

    return 1;
}

// Enable GX8002 I2S output
// Write 0x71 to register 0xC4 at address 0x2F
// Note: This function only writes the enable command. For complete initialization,
//       use bsp_gx8002_start_i2s() which includes reset and handshake.
uint8_t bsp_gx8002_enable_i2s(void)
{
    LOG_INF("Enabling GX8002 I2S output...");

    // Write 0x71 to register 0xC4 at address 0x2F
    uint8_t cmd[2] = {0xC4, 0x71};
    uint8_t ret    = bsp_gx8002_iic_write_data(BSP_GX_CMD_ADDR, cmd, 2);

    if (ret)
    {
        // Wait longer for chip to process and start I2S output
        // k_sleep(K_MSEC(200));       // Increased from 100ms to 200ms
        gx8002_i2s_enabled = true;  // Mark I2S as enabled
        LOG_INF("✅ GX8002 I2S output enabled (0xC4=0x71)");
        LOG_INF("💡 GX8002 should now be sending I2S clocks (SCK, LRCK) and data");
        return 1;
    }
    else
    {
        LOG_ERR("Failed to enable GX8002 I2S output");
        gx8002_i2s_enabled = false;  // Mark I2S as not enabled on failure
        return 0;
    }
}

// Disable GX8002 I2S output
// Write 0x72 to register 0xC4 at address 0x2F
uint8_t bsp_gx8002_disable_i2s(void)
{
    LOG_INF("Disabling GX8002 I2S output...");

    // Write 0x72 to register 0xC4 at address 0x2F
    uint8_t cmd[2] = {0xC4, 0x72};
    uint8_t ret    = bsp_gx8002_iic_write_data(BSP_GX_CMD_ADDR, cmd, 2);

    if (ret)
    {
        k_sleep(K_MSEC(100));        // Wait for chip to process
        gx8002_i2s_enabled = false;  // Mark I2S as disabled
        LOG_INF("✅ GX8002 I2S output disabled (0xC4=0x72)");
        return 1;
    }
    else
    {
        LOG_ERR("Failed to disable GX8002 I2S output");
        return 0;
    }
}

// Get GX8002 microphone (VAD) state
// Write 0x70 to register 0xC4 at address 0x2F, then read register 0xA0
// State code: 0=abnormal/error, 1=normal
uint8_t bsp_gx8002_get_mic_state(uint8_t* state)
{
    if (state == NULL)
    {
        LOG_ERR("Invalid state pointer");
        return 0;
    }

    LOG_INF("Getting GX8002 microphone (VAD) state...");

    // Step 1: Write 0x70 to register 0xC4 at address 0x2F
    uint8_t cmd[2] = {0xC4, 0x70};
    uint8_t ret    = bsp_gx8002_iic_write_data(BSP_GX_CMD_ADDR, cmd, 2);

    if (!ret)
    {
        LOG_ERR("Failed to write VAD state query command");
        return 0;
    }

    // Step 2: Wait for chip to process (200ms as per user's code)
    k_sleep(K_MSEC(200));

    // Step 3: Read register 0xA0
    uint8_t reg    = 0xA0;
    uint8_t status = 0;
    ret            = bsp_gx8002_iic_read_data(BSP_GX_CMD_ADDR, reg, &status);

    if (!ret)
    {
        LOG_ERR("Failed to read VAD state from register 0xA0");
        return 0;
    }

    *state = status;

    // Log the state
    if (status == 0)
    {
        LOG_INF("VAD State: 0 (abnormal/error)");
    }
    else if (status == 1)
    {
        LOG_INF("VAD State: 1 (normal)");
    }
    else
    {
        LOG_WRN("VAD State: %d (unknown)", status);
    }

    return 1;
}

// Check if GX8002 I2S is enabled
uint8_t bsp_gx8002_is_i2s_enabled(void)
{
    return gx8002_i2s_enabled ? 1 : 0;
}
