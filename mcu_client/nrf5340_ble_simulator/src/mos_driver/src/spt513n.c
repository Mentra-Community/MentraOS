/*
 * @Author       : Cole
 * @Date         : 2025-12-26 17:29:42
 * @LastEditTime : 2025-12-29 16:58:34
 * @FilePath     : spt513n.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2025 
 *  SPDX-License-Identifier: Apache-2.0
 */


#include "spt513n.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <string.h>
#include "bal_os.h"

LOG_MODULE_REGISTER(SPT513N, LOG_LEVEL_INF);



// SPT513N I2C GPIO pins (software I2C only)
#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), spt513n_sda_gpios)
#define SPT513N_SOFT_I2C_AVAILABLE 1
static const struct gpio_dt_spec spt513n_i2c_sda = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), spt513n_sda_gpios);
static const struct gpio_dt_spec spt513n_i2c_scl = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), spt513n_scl_gpios);
#else
#define SPT513N_SOFT_I2C_AVAILABLE 0
#endif

// SPT513N reset GPIO from device tree (zephyr,user node)
// Note: Reset GPIO uses the same pin as SDA (P0.02) - this is why software I2C is required
#if DT_NODE_EXISTS(DT_PATH(zephyr_user)) && DT_NODE_HAS_PROP(DT_PATH(zephyr_user), spt513n_reset_gpios)
#define SPT513N_RESET_GPIO_AVAILABLE 1
#else
#define SPT513N_RESET_GPIO_AVAILABLE 0
#endif

// I2C initialization state
static bool spt513n_i2c_initialized = false;
static bool spt513n_driver_initialized = false;

// Software I2C timing parameters
#define SPT513N_SW_I2C_DELAY_US 6    /* I2C bit timing delay (µs) */
#define SPT513N_SW_I2C_TIMEOUT 1000U /* ACK wait timeout (loops) */

#if SPT513N_SOFT_I2C_AVAILABLE
/* --- Software I2C GPIO operations --- */
static int spt513n_sda_out(void)
{
    return gpio_pin_configure_dt(&spt513n_i2c_sda, GPIO_OUTPUT);
}

static int spt513n_sda_in(void)
{
    return gpio_pin_configure_dt(&spt513n_i2c_sda, GPIO_INPUT | GPIO_PULL_UP);
}

static int spt513n_scl_out(void)
{
    return gpio_pin_configure_dt(&spt513n_i2c_scl, GPIO_OUTPUT);
}

// Note: spt513n_scl_in is kept for potential future use in I2C clock stretching detection
__attribute__((unused)) static int spt513n_scl_in(void)
{
    return gpio_pin_configure_dt(&spt513n_i2c_scl, GPIO_INPUT | GPIO_PULL_UP);
}

static void spt513n_sda_high(void)
{
    gpio_pin_set_raw(spt513n_i2c_sda.port, spt513n_i2c_sda.pin, 1);
}

static void spt513n_sda_low(void)
{
    gpio_pin_set_raw(spt513n_i2c_sda.port, spt513n_i2c_sda.pin, 0);
}

static void spt513n_scl_high(void)
{
    gpio_pin_set_raw(spt513n_i2c_scl.port, spt513n_i2c_scl.pin, 1);
}

static void spt513n_scl_low(void)
{
    gpio_pin_set_raw(spt513n_i2c_scl.port, spt513n_i2c_scl.pin, 0);
}

static int spt513n_sda_read(void)
{
    return gpio_pin_get_raw(spt513n_i2c_sda.port, spt513n_i2c_sda.pin);
}

/* --- Software I2C protocol functions --- */
static void spt513n_i2c_start(void)
{
    spt513n_sda_high();
    spt513n_scl_high();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    spt513n_sda_low();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    spt513n_scl_low();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
}

static void spt513n_i2c_stop(void)
{
    spt513n_sda_low();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    spt513n_scl_high();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    spt513n_sda_high();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
}

/* Send one byte and wait for ACK */
static int spt513n_i2c_write_byte(uint8_t b)
{
    spt513n_sda_out();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    
    /* Send 8 bits */
    for (int i = 7; i >= 0; i--)
    {
        spt513n_scl_low();
        if (b & (1 << i))
            spt513n_sda_high();
        else
            spt513n_sda_low();
        mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
        
        spt513n_scl_high();
        mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    }
    
    /* 9th clock for ACK */
    spt513n_scl_low();
    spt513n_sda_in(); /* Switch to input, wait for slave ACK */
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    
    spt513n_scl_high();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US / 2);
    
    uint32_t t = 0;
    while (spt513n_sda_read() && t++ < SPT513N_SW_I2C_TIMEOUT)
    {
        mos_busy_wait(10);
    }
    
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US / 2);
    spt513n_scl_low();
    spt513n_sda_out();
    
    if (t >= SPT513N_SW_I2C_TIMEOUT)
    {
        LOG_ERR("I2C ACK timeout");
        return -EIO;
    }
    return 0;
}

/* Read one byte, send ACK/NACK at the end */
static int spt513n_i2c_read_byte(uint8_t *p, bool ack)
{
    uint8_t val = 0;
    spt513n_sda_in();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    
    for (int i = 7; i >= 0; i--)
    {
        spt513n_scl_low();
        mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
        
        spt513n_scl_high();
        mos_busy_wait(SPT513N_SW_I2C_DELAY_US / 2);
        if (spt513n_sda_read())
            val |= (1 << i);
        mos_busy_wait(SPT513N_SW_I2C_DELAY_US / 2);
    }
    
    /* 9th clock, host ACK/NACK */
    spt513n_scl_low();
    spt513n_sda_out();
    if (ack)
        spt513n_sda_low();
    else
        spt513n_sda_high();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    
    spt513n_scl_high();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    
    spt513n_scl_low();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    spt513n_sda_high();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);
    
    *p = val;
    return 0;
}

/* Software I2C write (similar to twi_io_write) */
static int spt513n_sw_i2c_write(uint8_t addr, const uint8_t *data, size_t len)
{
    spt513n_i2c_start();
    
    /* Send device address + write bit */
    if (spt513n_i2c_write_byte((addr << 1) | 0) != 0)
    {
        spt513n_i2c_stop();
        return -EIO;
    }
    
    /* Send data (if data is NULL, just send address for probing) */
    if (data != NULL)
    {
        for (size_t i = 0; i < len; i++)
        {
            if (spt513n_i2c_write_byte(data[i]) != 0)
            {
                spt513n_i2c_stop();
                return -EIO;
            }
        }
    }
    
    spt513n_i2c_stop();
    return 0;
}

/* Software I2C read (similar to twi_io_read) */
static int spt513n_sw_i2c_read(uint8_t addr, uint8_t *data, size_t len)
{
    spt513n_i2c_start();
    
    /* Send device address + read bit */
    if (spt513n_i2c_write_byte((addr << 1) | 1) != 0)
    {
        spt513n_i2c_stop();
        return -EIO;
    }
    
    /* Read data */
    for (size_t i = 0; i < len; i++)
    {
        bool ack = (i < len - 1); /* ACK all but last byte */
        if (spt513n_i2c_read_byte(&data[i], ack) != 0)
        {
            spt513n_i2c_stop();
            return -EIO;
        }
    }
    
    spt513n_i2c_stop();
    return 0;
}

/**
 * @brief Initialize software I2C for SPT513N
 * 
 * Note: Only software I2C is supported because SDA pin (P0.02) must be used
 * for both I2C communication and hardware reset operations.
 */
static int spt513n_i2c_init(void)
{
    if (spt513n_i2c_initialized)
    {
        return 0;
    }

    if (!SPT513N_SOFT_I2C_AVAILABLE)
    {
        LOG_ERR("SPT513N software I2C GPIO not available in device tree");
        return -ENODEV;
    }

    if (!gpio_is_ready_dt(&spt513n_i2c_sda) || !gpio_is_ready_dt(&spt513n_i2c_scl))
    {
        LOG_ERR("SPT513N I2C GPIO devices not ready");
        return -ENODEV;
    }

    /* Configure SDA and SCL as outputs initially (will switch SDA to input when reading) */
    int ret = spt513n_sda_out();
    if (ret != 0)
    {
        LOG_ERR("Failed to configure SDA GPIO: %d", ret);
        return ret;
    }
    
    ret = spt513n_scl_out();
    if (ret != 0)
    {
        LOG_ERR("Failed to configure SCL GPIO: %d", ret);
        return ret;
    }

    /* Set both lines high (idle state) */
    spt513n_sda_high();
    spt513n_scl_high();
    mos_busy_wait(SPT513N_SW_I2C_DELAY_US);

    spt513n_i2c_initialized = true;
    LOG_INF("SPT513N software I2C initialized (SDA: P0.02, SCL: P0.03)");
    return 0;
}
#else
/**
 * @brief Initialize software I2C for SPT513N (fallback - should not be reached)
 * 
 * Note: This should never be reached if device tree is configured correctly.
 * Software I2C is required for SPT513N due to pin multiplexing requirements.
 */
static int spt513n_i2c_init(void)
{
    LOG_ERR("SPT513N software I2C GPIO not available in device tree");
    LOG_ERR("Please configure spt513n_sda-gpios and spt513n_scl-gpios in device tree");
    return -ENODEV;
}
#endif

bool spt513n_is_initialized(void)
{
    return spt513n_driver_initialized;
}

/**
 * @brief Initialize SPT513N reset GPIO
 * 
 * Note: Reset GPIO uses the same pin as SDA (P0.02). With software I2C,
 * the SDA pin is already configured in spt513n_i2c_init(), so no separate
 * GPIO configuration is needed here.
 */
static int spt513n_gpio_init(void)
{
#if SPT513N_RESET_GPIO_AVAILABLE
    // With software I2C, SDA pin is already configured in spt513n_i2c_init()
    // Reset GPIO uses the same pin (P0.02), so no separate configuration needed
    LOG_INF("SPT513N reset GPIO configured (P0.02, shared with software I2C SDA)");
    return 0;
#else
    LOG_WRN("SPT513N reset GPIO not configured in device tree");
    return -ENODEV;
#endif
}

int spt513n_init(void)
{
    int ret;

    ret = spt513n_i2c_init();
    if (ret != 0)
    {
        return ret;
    }

    ret = spt513n_gpio_init();
    if (ret != 0)
    {
        // GPIO init failure is not critical, soft reset can still work
        LOG_WRN("SPT513N GPIO init failed, soft reset only mode");
    }

    spt513n_driver_initialized = true;
    return 0;
}

/**
 * @brief Hardware reset SPT513N via GPIO
 * 
 * FAE specification: SPT513N IC reset function is set on GPIO01 (P0.02), falling edge active
 * FAE specification: SPT513N IC 复位功能设置在 GPIO01 (P0.02) 上，下降沿有效
 * Reset sequence: 
 *   1. Ensure pin is HIGH (normal state, not reset)
 *   2. Pull LOW to generate falling edge (trigger reset / 触发复位)
 *   3. Hold LOW for 20ms (maintain reset state / 保持复位状态)
 *   4. Pull HIGH to release reset (release reset / 释放复位)
 *   5. Hold HIGH for 10ms (stable state / 稳定状态)
 * 
 * Note: This function uses software I2C SDA pin control, allowing the same
 * pin to be used for both I2C communication and reset operations.
 */
void spt513n_reset(void)
{
#if SPT513N_RESET_GPIO_AVAILABLE && SPT513N_SOFT_I2C_AVAILABLE
    // FAE: GPIO01 (P0.02) falling edge active
    // FAE: GPIO01 (P0.02) 下降沿有效
    // With software I2C, we have full control over SDA pin (P0.02)
    LOG_INF("Resetting SPT513N via GPIO01 (P0.02) - falling edge active (下降沿有效)...");
    
    // Configure SDA as GPIO output for reset
    spt513n_sda_out();
    
    // Step 1: Ensure pin is HIGH (normal state, not reset)
    spt513n_sda_high();
    k_sleep(K_MSEC(1));  // Ensure stable HIGH state
    
    // Step 2: Pull LOW to generate falling edge (trigger reset / 下降沿触发复位)
    LOG_INF("Generating falling edge (HIGH -> LOW) to trigger reset...");
    spt513n_sda_low();
    
    // Step 3: Hold LOW for 20ms (maintain reset state / 保持复位状态)
    k_sleep(K_MSEC(20));
    
    // Step 4: Pull HIGH to release reset (release reset / 释放复位)
    LOG_INF("Releasing reset (LOW -> HIGH)...");
    spt513n_sda_high();
    
    // Step 5: Hold HIGH for 10ms (stable state / 稳定状态)
    k_sleep(K_MSEC(10));
    
    // SDA is already configured for software I2C, no need to reinitialize
    LOG_INF("SPT513N hardware reset completed (falling edge triggered)");
#else
    LOG_WRN("SPT513N reset GPIO not available, using soft reset");
    spt513n_soft_reset();
#endif
}


int spt513n_reset_and_connect(void)
{
#if SPT513N_RESET_GPIO_AVAILABLE && SPT513N_SOFT_I2C_AVAILABLE
    // FAE: GPIO01 (P0.02) falling edge active, pull LOW for 20ms, pull HIGH for 10ms, complete connect command within 100ms
    // FAE: GPIO01 (P0.02) 下降沿有效，拉低20ms，拉高10ms，100ms内跑完connect指令
    // With software I2C, we have full control over SDA pin (P0.02)
    LOG_INF("Resetting SPT513N via GPIO01 (P0.02) and connecting - falling edge active (下降沿有效)...");
    
    // Ensure software I2C is initialized
    if (!spt513n_i2c_initialized)
    {
        int ret = spt513n_i2c_init();
        if (ret != 0)
        {
            LOG_ERR("Failed to initialize software I2C: %d", ret);
            return ret;
        }
    }
    
    // Step 1: Ensure pin is HIGH (normal state, not reset)
    spt513n_sda_out();
    spt513n_sda_high();
    k_sleep(K_MSEC(1));  // Ensure stable HIGH state
    
    // Step 2: Pull LOW to generate falling edge (trigger reset / 下降沿触发复位)
    LOG_INF("Step 1: Generating falling edge (HIGH -> LOW) to trigger reset...");
    spt513n_sda_low();
    
    // Step 3: Hold LOW for 20ms (maintain reset state / 保持复位状态)
    k_sleep(K_MSEC(20));
    
    // Step 4: Pull HIGH to release reset (release reset / 释放复位)
    LOG_INF("Step 2: Releasing reset (LOW -> HIGH)...");
    spt513n_sda_high();
    
    // Step 5: Hold HIGH for 10ms (stable state / 稳定状态)
    k_sleep(K_MSEC(10));
    
    // Total reset time: 1ms (HIGH) + 20ms (LOW) + 10ms (HIGH) = 31ms
    // Remaining time for connect: 100ms - 31ms = 69ms
    
    LOG_INF("Reset completed (31ms), starting connect within 100ms window (69ms remaining)...");
    
    // Step 6: Connect must be completed within 100ms after reset starts
    uint8_t ret = spt513n_connect();
    if (ret == 0)
    {
        LOG_INF("✅ SPT513N reset and connect successful (within 100ms window)");
        LOG_INF("   Reset: 31ms (falling edge triggered, 20ms LOW + 10ms HIGH)");
        LOG_INF("   Connect: completed within remaining 69ms");
        return 0;
    }
    else
    {
        LOG_ERR("❌ SPT513N connect failed after reset (may have exceeded 100ms window)");
        return -EIO;
    }
#else
    LOG_WRN("SPT513N reset GPIO not available, using soft reset");
    int ret = spt513n_soft_reset();
    if (ret != 0)
    {
        return ret;
    }
    k_sleep(K_MSEC(10));
    ret = spt513n_connect();
    return (ret == 0) ? 0 : -EIO;
#endif
}

int spt513n_soft_reset(void)
{
    uint8_t reg_temp;
    
    reg_temp = spt513n_read_reg(0xC8);
    if (reg_temp == 0xFF)
    {
        LOG_ERR("Failed to read register 0xC8 for soft reset");
        return -EIO;
    }
    
    reg_temp |= 0x02;
    int ret = spt513n_write_reg(0xC8, reg_temp);
    if (ret != 0)
    {
        LOG_ERR("Failed to write register 0xC8 for soft reset");
        return ret;
    }

    LOG_INF("SPT513N soft reset command sent");
    return 0;
}

/**
 * @brief Read a register from SPT513N via software I2C
 * 
 * @param addr Register address to read
 * @return Register value, or 0xFF on error
 */
uint8_t spt513n_read_reg(uint8_t addr)
{
    if (!spt513n_i2c_initialized)
    {
        if (spt513n_i2c_init() != 0)
        {
            LOG_ERR("I2C not initialized, cannot read register 0x%02X", addr);
            return 0xFF;
        }
    }

#if SPT513N_SOFT_I2C_AVAILABLE
    // Software I2C: Write register address, then read value (like demo code)
    uint8_t value = 0xFF;
    
    // Write register address first
    int ret = spt513n_sw_i2c_write(SPT513N_I2C_ADDR, &addr, 1);
    if (ret == 0)
    {
        // Small delay before read
        mos_busy_wait(100);
        // Then read the value
        ret = spt513n_sw_i2c_read(SPT513N_I2C_ADDR, &value, 1);
    }
    
    if (ret != 0)
    {
        LOG_ERR("Failed to read register 0x%02X from I2C address 0x%02X: %d", 
                addr, SPT513N_I2C_ADDR, ret);
        LOG_ERR("Check I2C bus connection, SPT513N power supply, and pull-up resistors");
        return 0xFF;
    }
#else
    LOG_ERR("Software I2C not available");
    return 0xFF;
#endif

    LOG_DBG("Read register 0x%02X = 0x%02X", addr, value);
    return value;
}

/**
 * @brief Write a register to SPT513N via software I2C
 * 
 * @param addr Register address to write
 * @param value Value to write
 * @return 0 on success, negative error code on failure
 */
int spt513n_write_reg(uint8_t addr, uint8_t value)
{
    if (!spt513n_i2c_initialized)
    {
        if (spt513n_i2c_init() != 0)
        {
            LOG_ERR("I2C not initialized, cannot write register 0x%02X", addr);
            return -ENODEV;
        }
    }

#if SPT513N_SOFT_I2C_AVAILABLE
    // Software I2C: Write address and value together
    uint8_t data[2] = {addr, value};
    int ret = spt513n_sw_i2c_write(SPT513N_I2C_ADDR, data, 2);
    if (ret != 0)
    {
        LOG_ERR("Failed to write register 0x%02X = 0x%02X: %d", addr, value, ret);
        return ret;
    }
    
    LOG_DBG("Write register 0x%02X = 0x%02X", addr, value);
    return 0;
#else
    LOG_ERR("Software I2C not available");
    return -ENODEV;
#endif
}

/**
 * @brief Read data from SPT513N internal EEPROM
 * @param addr EEPROM address (0-63, 64 bytes total)
 * @return EEPROM data byte, or 0xFF on error
 */
uint8_t spt513n_read_eeprom(uint8_t addr)
{
    if (addr >= 64)
    {
        LOG_ERR("EEPROM address out of range: %d", addr);
        return 0xFF;
    }

    // Enable EEPROM read mode (write 0x10 to register 0xE0)
    spt513n_write_reg(0xE0, 0x10);
    
    // Read data from EEPROM address (mapped to register 0x80 + addr)
    uint8_t data = spt513n_read_reg(addr + 0x80);
    
    // Disable EEPROM access (write 0x00 to register 0xE0)
    spt513n_write_reg(0xE0, 0x00);
    
    return data;
}

/**
 * @brief Write data to SPT513N internal EEPROM
 * 
 * Note: EEPROM write requires time. After writing, check bit 1 of status register (0xE1)
 * 注意：EEPROM 写入需要时间，写入后需要检查状态寄存器 (0xE1) 的 bit 1
 * to confirm write completion. Wait for write completion after each byte write.
 * 来确认写入是否完成。每次写入一个字节后都需要等待写入完成。
 * 
 * @param addr EEPROM address (0-63, 64 bytes total)
 * @param data Data byte to write
 * @return 0 on success, negative error code on failure
 */
int spt513n_write_eeprom(uint8_t addr, uint8_t data)
{
    if (addr >= 64)
    {
        LOG_ERR("EEPROM address out of range: %d", addr);
        return -EINVAL;
    }

    // Enable EEPROM write mode (write 0x20 to register 0xE0)
    spt513n_write_reg(0xE0, 0x20);
    
    // Write data to EEPROM address (mapped to register 0x80 + addr)
    int ret = spt513n_write_reg(addr + 0x80, data);
    
    // Disable EEPROM access (write 0x00 to register 0xE0)
    spt513n_write_reg(0xE0, 0x00);
    
    return ret;
}

/**
 * @brief Get EEPROM write status
 * 
 * Check if EEPROM write operation is completed.
 * 检查 EEPROM 写入操作是否完成。
 * Return value: 0 = write completed, non-zero = write in progress
 * 返回值：0 = 写入完成，非0 = 正在写入中
 * 
 * @return EEPROM write status (bit 1 of register 0xE1)
 */
uint8_t spt513n_get_eeprom_status(void)
{
    // Bit 1 of register 0xE1 indicates EEPROM write status
    // 0 = write completed, 1 = write in progress
    return (spt513n_read_reg(0xE1) & 0x02);
}

uint8_t spt513n_connect(void)
{
    uint8_t reg_temp;
    
    // Connect test - read register 0xF0, should be 0x80
    // Note: This must complete within 100ms window after reset starts
    reg_temp = spt513n_read_reg(0xF0);
    if (reg_temp != 0x80)
    {
        // Retry up to 3 times (but minimize delays to stay within 100ms window)
        for (int i = 0; i < 3; i++)
        {
            // Use shorter delay (1ms) to stay within 100ms window
            k_sleep(K_MSEC(1));
            reg_temp = spt513n_read_reg(0xF0);
            if (reg_temp == 0x80)
            {
                LOG_INF("SPT513N I2C connect OK (retry %d)", i + 1);
                break;
            }
        }

        if (reg_temp != 0x80)
        {
            LOG_ERR("SPT513N I2C connect failed (reg 0xF0 = 0x%02X)", reg_temp);
            LOG_ERR("   Check: 1) Reset sequence completed (20ms low + 10ms high)");
            LOG_ERR("         2) Connect started within 100ms after reset");
            LOG_ERR("         3) I2C bus connection (SDA, SCL)");
            return 1;
        }
    }
    
    LOG_INF("SPT513N I2C connect test success (reg 0xF0 = 0x%02X)", reg_temp);
    
    // Connect hold - configure system control register
    reg_temp = spt513n_read_reg(0xC8);  // Read sys ctrl reg
    if (reg_temp == 0xFF)
    {
        LOG_ERR("Failed to read register 0xC8");
        return 1;
    }
    
    reg_temp |= 0x44;
    spt513n_write_reg(0xC8, reg_temp);
    spt513n_write_reg(0xC0, 0x00);
    spt513n_write_reg(0xC1, 0x01);
    
    reg_temp = spt513n_read_reg(0xCA);
    if (reg_temp != 0x80)
    {
        LOG_ERR("SPT513N I2C hold failed (reg 0xCA = 0x%02X)", reg_temp);
        return 1;
    }
    
    LOG_INF("SPT513N I2C hold success (reg 0xCA = 0x%02X)", reg_temp);
    
    // PRST MASK - mask reset pin
    reg_temp = spt513n_read_reg(0x18);
    if (reg_temp == 0xFF)
    {
        LOG_ERR("Failed to read register 0x18");
        return 1;
    }
    
    reg_temp |= 0x80;
    spt513n_write_reg(0x18, reg_temp);
    
    return 0;
}

uint8_t spt513n_config_verify(const uint8_t *config_buffer, const uint8_t *read_buffer, uint8_t length)
{
    for (int i = 0; i < length; i++)
    {
        if (config_buffer[i] != read_buffer[i])
        {
            return 1;  // Mismatch
        }
    }
    return 0;  // Match
}

/**
 * @brief Read touch panel configuration from EEPROM
 * 
 * Read touch IC configuration parameters (read 64-byte configuration data from EEPROM)
 * 读取触摸 IC 的配置参数（从 EEPROM 中读取 64 字节配置数据）
 * 
 * @param buffer Buffer to store configuration data (64 bytes)
 * @param length Buffer length (max 64 bytes)
 * @return 0 on success, negative error code on failure
 */
int spt513n_read_config(uint8_t *buffer, uint8_t length)
{
    if (buffer == NULL || length == 0)
    {
        return -EINVAL;
    }

    if (length > 64)
    {
        length = 64;
    }

    // Read configuration from EEPROM (64 bytes total)
    for (int i = 0; i < length; i++)
    {
        buffer[i] = spt513n_read_eeprom(i);
    }

    return 0;
}

/**
 * @brief Update SPT513N touch panel configuration in EEPROM
 * @param config_buffer Pointer to 64-byte configuration data
 * @param config_len Configuration data length (max 64 bytes)
 * @return 0 on success, negative error code on failure
 */
int spt513n_update_config(const uint8_t *config_buffer, uint8_t config_len)
{
    if (config_buffer == NULL || config_len == 0)
    {
        return -EINVAL;
    }

    if (config_len > 64)
    {
        config_len = 64;
    }

    uint8_t reg_temp;
    uint8_t eep_buffer[64];
    uint8_t eep_config_update;
    uint8_t over_time_cnt = 0;

    LOG_INF("SPT513N touch panel configuration update started");

    // Connect to test mode (must be within 100ms after reset)
    reg_temp = spt513n_connect();
    if (reg_temp != 0)
    {
        LOG_ERR("SPT513N connect failed, performing soft reset");
        spt513n_soft_reset();
        k_sleep(K_MSEC(30));
        return -EIO;
    }

    // Step 1: Read current EEPROM configuration (64 bytes)
    // EEPROM stores the current touch panel configuration parameters
    // EEPROM 存储了触摸屏的当前配置参数
    LOG_INF("Reading current EEPROM configuration (64 bytes)...");
    for (int i = 0; i < 64; i++)
    {
        eep_buffer[i] = spt513n_read_eeprom(i);
    }

    // Step 2: Verify if update is needed
    // Compare new configuration with current configuration to determine if update is needed
    // 比较新配置和当前配置，判断是否需要更新
    LOG_INF("Verifying if configuration update is needed...");
    
    // Reserve some registers (preserve bits from existing config)
    // Preserve some bits of certain registers (these bits may be IC-specific and should not be overwritten)
    uint8_t config_to_verify[64];
    memcpy(config_to_verify, config_buffer, 64);
    config_to_verify[7] &= 0xE0;  // Clear low 5 bits (preserve existing bits)
    config_to_verify[8] &= 0xC0;  // Clear low 6 bits (preserve existing bits)
    config_to_verify[7] |= (eep_buffer[7] & 0x1F);  // Restore preserved bits
    config_to_verify[8] |= (eep_buffer[8] & 0x3F);  // Restore preserved bits

    eep_config_update = spt513n_config_verify(config_to_verify, eep_buffer, 64);
    if (eep_config_update == 0)
    {
        LOG_INF("EEPROM configuration is already up to date, no update needed");
        spt513n_soft_reset();
        k_sleep(K_MSEC(30));
        return 0;
    }

    // Step 3: Wait for EEPROM to be ready (if previous write is in progress)
    LOG_INF("Waiting for EEPROM to be ready...");
    while (spt513n_get_eeprom_status())
    {
        k_sleep(K_MSEC(10));
        over_time_cnt++;
        if (over_time_cnt > 30)
        {
            LOG_ERR("EEPROM write timeout (previous write not completed)");
            spt513n_soft_reset();
            k_sleep(K_MSEC(30));
            return -ETIMEDOUT;
        }
    }

    // Step 4: Write new configuration to EEPROM
    // Write new touch panel configuration parameters to EEPROM (64 bytes)
    // 将新的触摸屏配置参数写入 EEPROM（64 字节）
    LOG_INF("Writing new touch panel configuration to EEPROM (64 bytes)...");
    for (int i = 0; i < config_len; i++)
    {
        spt513n_write_eeprom(i, config_buffer[i]);
        
        // Wait for each byte write to complete
        // EEPROM write requires time, must wait for each byte write to complete
        // EEPROM 写入需要时间，必须等待每个字节写入完成
        over_time_cnt = 0;
        while (spt513n_get_eeprom_status())
        {
            k_sleep(K_MSEC(10));
            over_time_cnt++;
            if (over_time_cnt > 30)
            {
                LOG_ERR("EEPROM write timeout at address %d", i);
                spt513n_soft_reset();
                k_sleep(K_MSEC(30));
                return -ETIMEDOUT;
            }
        }
    }

    k_sleep(K_MSEC(15));

    // Reboot after write
    spt513n_soft_reset();
    k_sleep(K_MSEC(30));

    // Connect again
    reg_temp = spt513n_connect();
    if (reg_temp != 0)
    {
        LOG_ERR("SPT513N connect failed after EEPROM write");
        spt513n_soft_reset();
        k_sleep(K_MSEC(30));
        return -EIO;
    }

    // Read and verify EEPROM
    LOG_INF("Reading EEPROM after update");
    for (int i = 0; i < 64; i++)
    {
        eep_buffer[i] = spt513n_read_eeprom(i);
    }

    LOG_INF("Verifying EEPROM after update");
    eep_config_update = spt513n_config_verify(config_to_verify, eep_buffer, 64);
    if (eep_config_update != 0)
    {
        LOG_ERR("EEPROM config update verification failed");
        spt513n_soft_reset();
        k_sleep(K_MSEC(30));
        return -EIO;
    }

    LOG_INF("✅ Touch panel configuration update successful!");
    LOG_INF("   New configuration has been written to EEPROM and verified");
    
    // Step 6: Reboot IC to apply new configuration
    // Reset IC to make new touch panel configuration parameters effective
    // 复位 IC 使新的触摸屏配置参数生效
    LOG_INF("Rebooting IC to apply new touch panel configuration...");
    spt513n_soft_reset();
    k_sleep(K_MSEC(30));

    return 0;
}

/**
 * @brief Scan I2C bus for SPT513N device (software I2C only)
 * 
 * @param found_addr Pointer to store found address (optional)
 * @return 0 if SPT513N found, negative error code otherwise
 */
int spt513n_scan_i2c(uint8_t *found_addr)
{
    if (!spt513n_i2c_initialized)
    {
        if (spt513n_i2c_init() != 0)
        {
            LOG_ERR("I2C not initialized, cannot scan");
            return -ENODEV;
        }
    }

    uint8_t test_reg = 0xF0;  // Test register address
    uint8_t test_value = 0;
    int found_count = 0;
    uint8_t found = 0;

#if SPT513N_SOFT_I2C_AVAILABLE
    LOG_INF("Scanning I2C bus for devices (software I2C mode)...");
    
    // First, try to read from SPT513N expected address directly
    LOG_INF("Checking SPT513N at address 0x%02X...", SPT513N_I2C_ADDR);
    
    // Use software I2C to read register
    int ret = spt513n_sw_i2c_write(SPT513N_I2C_ADDR, &test_reg, 1);
    if (ret == 0)
    {
        mos_busy_wait(100);
        ret = spt513n_sw_i2c_read(SPT513N_I2C_ADDR, &test_value, 1);
    }
    
    if (ret == 0)
    {
        LOG_INF("✅ Device found at 0x%02X, register 0xF0 = 0x%02X", SPT513N_I2C_ADDR, test_value);
        if (found_addr != NULL)
        {
            *found_addr = SPT513N_I2C_ADDR;
        }
        return 0;
    }
    else
    {
        LOG_WRN("Device at 0x%02X not responding (error: %d)", SPT513N_I2C_ADDR, ret);
    }
    
    // Scan I2C addresses from 0x08 to 0x77 (valid I2C address range)
    LOG_INF("Scanning I2C address range 0x08-0x77...");
    for (uint8_t addr = 0x08; addr <= 0x77; addr++)
    {
        // Skip reserved addresses
        if (addr >= 0x78 && addr <= 0x7F)
        {
            continue;
        }
        
        // Try to write 0 bytes (just address check) - some devices respond to this
        ret = spt513n_sw_i2c_write(addr, NULL, 0);
        if (ret == 0)
        {
            LOG_INF("Found I2C device at address 0x%02X", addr);
            found_count++;
            found = addr;
            
            if (addr == SPT513N_I2C_ADDR)
            {
                LOG_INF("✅ SPT513N found at expected address 0x%02X", addr);
                if (found_addr != NULL)
                {
                    *found_addr = addr;
                }
                return 0;
            }
        }
        
        // Also try read operation for devices that don't respond to write
        if (ret != 0 && addr == SPT513N_I2C_ADDR)
        {
            // For SPT513N, try reading a register
            uint8_t dummy = 0;
            ret = spt513n_sw_i2c_write(addr, &test_reg, 1);
            if (ret == 0)
            {
                mos_busy_wait(100);
                ret = spt513n_sw_i2c_read(addr, &dummy, 1);
                if (ret == 0)
                {
                    LOG_INF("✅ SPT513N found at 0x%02X (via read test)", addr);
                    if (found_addr != NULL)
                    {
                        *found_addr = addr;
                    }
                    return 0;
                }
            }
        }
    }
#else
    LOG_ERR("Software I2C not available");
    return -ENODEV;
#endif

    if (found_count == 0)
    {
        LOG_ERR("No I2C devices found on I2C bus");
        LOG_ERR("Possible issues:");
        LOG_ERR("  1. I2C bus wiring problem (SDA, SCL)");
        LOG_ERR("  2. Missing pull-up resistors (typically 4.7kΩ on SDA and SCL)");
        LOG_ERR("  3. SPT513N not powered on");
        LOG_ERR("  4. I2C pins configured incorrectly in device tree");
        LOG_ERR("  5. I2C bus speed/configuration issue");
    }
    else
    {
        LOG_WRN("Found %d I2C device(s) but SPT513N (0x%02X) not found", found_count, SPT513N_I2C_ADDR);
        if (found_addr != NULL && found != 0)
        {
            *found_addr = found;
        }
    }

    return -ENODEV;
}


