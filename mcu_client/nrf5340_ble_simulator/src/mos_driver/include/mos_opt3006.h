/***
 * @Author       : Cole
 * @Date         : 2025-10-15 16:01:10
 * @LastEditTime : 2026-01-29 10:44:40
 * @FilePath     : mos_opt3006.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef MOS_OPT3006_H_
#define MOS_OPT3006_H_

#include <stdbool.h>
#include <zephyr/device.h>
#include <zephyr/drivers/i2c.h>

// I2C Device Address | I2C设备地址
// Note: This is 7-bit address format (Zephyr standard)
// 注意: 这是7位地址格式（Zephyr标准）
#define OPT3006_I2C_ADDR \
    0x45  // ti最新邮件确认了，opt3006的地址是0x45 | ti latest email confirmed, opt3006 address is 0x45

// Register Addresses | 寄存器地址
#define OPT3006_REG_RESULT          0x00  // Result register (read-only) | 结果寄存器(只读)
#define OPT3006_REG_CONFIG          0x01  // Configuration register | 配置寄存器
#define OPT3006_REG_LOW_LIMIT       0x02  // Low limit register | 低阈值寄存器
#define OPT3006_REG_HIGH_LIMIT      0x03  // High limit register | 高阈值寄存器
#define OPT3006_REG_MANUFACTURER_ID 0x7E  // Manufacturer ID register | 制造商ID寄存器
#define OPT3006_REG_DEVICE_ID       0x7F  // Device ID register | 设备ID寄存器

// Device Identification Values | 设备识别值
#define OPT3006_MANUFACTURER_ID 0x5449  // "TI" in ASCII | ASCII码"TI"
#define OPT3006_DEVICE_ID \
    0x3001  // OPT3006 device identifier | OPT3006设备标识符
            // Note: OPT3006 Device ID is 0x3001 (from datasheet offset 7Fh)
            // 注意: OPT3006设备ID是0x3001（来自数据手册偏移7Fh）

// Configuration Register Bit Positions | 配置寄存器位位置
// 根据OPT3006数据手册Configuration Register (offset = 01h)定义:
// Bit 15-12: RN[3:0] - Range Number (量程编号，4位，默认1100b=自动)
// Bit 11:    CT - Conversion Time (转换时间，1位: 0=100ms, 1=800ms，默认1b)
// Bit 10-9:  M[1:0] - Mode of Conversion (工作模式，2位: 00=Shutdown, 01=Single, 10/11=Continuous，默认00b)
// Bit 8:     OVF - Overflow Flag (溢出标志，只读，默认0b)
// Bit 7:     CRF - Conversion Ready Flag (转换就绪标志，只读，默认0b)
// Bit 6:     FH - Flag High (高阈值标志，只读，默认0b)
// Bit 5:     FL - Flag Low (低阈值标志，只读，默认0b)
// Bit 4:     L - Latch (锁存模式，1=锁存, 0=透明，默认1b)
// Bit 3:     POL - Polarity (极性，1=高有效, 0=低有效，默认0b)
// Bit 2:     ME - Mask Exponent (掩码指数，默认0b)
// Bit 1-0:   FC[1:0] - Fault Count (故障计数，00=1次, 01=2次, 10=4次, 11=8次，默认00b)
// 复位默认值: 0xC810 = 1100 1000 0001 0000
#define OPT3006_CONFIG_RN_SHIFT 12  // Range Number field shift (bits 15:12) | 量程编号字段偏移(位15:12)
#define OPT3006_CONFIG_CT_BIT   11  // Conversion Time bit position (bit 11) | 转换时间位位置(位11)
#define OPT3006_CONFIG_M_SHIFT  9   // Mode of Conversion field shift (bits 10:9) | 转换模式字段偏移(位10:9)
#define OPT3006_CONFIG_OVF_BIT  8   // Overflow flag bit (bit 8, read-only) | 溢出标志位(位8，只读)
#define OPT3006_CONFIG_CRF_BIT  7   // Conversion Ready Flag bit (bit 7, read-only) | 转换就绪标志位(位7，只读)
#define OPT3006_CONFIG_FH_BIT   6   // Flag High bit (bit 6, read-only) | 高阈值标志位(位6，只读)
#define OPT3006_CONFIG_FL_BIT   5   // Flag Low bit (bit 5, read-only) | 低阈值标志位(位5，只读)
#define OPT3006_CONFIG_L_BIT    4   // Latch bit (bit 4) | 锁存位(位4)
#define OPT3006_CONFIG_POL_BIT  3   // Polarity bit (bit 3) | 极性位(位3)
#define OPT3006_CONFIG_ME_BIT   2   // Mask Exponent bit (bit 2) | 掩码指数位(位2)
#define OPT3006_CONFIG_FC_SHIFT 0   // Fault Count field shift (bits 1:0) | 故障计数字段偏移(位1:0)

// Configuration Register Bit Masks | 配置寄存器位掩码
#define OPT3006_CONFIG_RN_MASK  0xF000  // Range Number mask (bits 15:12) | 量程编号掩码(位15:12)
#define OPT3006_CONFIG_CT_MASK  0x0800  // Conversion Time mask (bit 11) | 转换时间掩码(位11)
#define OPT3006_CONFIG_M_MASK   0x0600  // Mode mask (bits 10:9) | 模式掩码(位10:9)
#define OPT3006_CONFIG_OVF_MASK 0x0100  // Overflow flag mask (bit 8) | 溢出标志掩码(位8)
#define OPT3006_CONFIG_CRF_MASK 0x0080  // Conversion Ready mask (bit 7) | 转换就绪掩码(位7)
#define OPT3006_CONFIG_FH_MASK  0x0040  // Flag High mask (bit 6) | 高阈值标志掩码(位6)
#define OPT3006_CONFIG_FL_MASK  0x0020  // Flag Low mask (bit 5) | 低阈值标志掩码(位5)
#define OPT3006_CONFIG_L_MASK   0x0010  // Latch mask (bit 4) | 锁存掩码(位4)
#define OPT3006_CONFIG_POL_MASK 0x0008  // Polarity mask (bit 3) | 极性掩码(位3)
#define OPT3006_CONFIG_ME_MASK  0x0004  // Mask Exponent mask (bit 2) | 掩码指数掩码(位2)
#define OPT3006_CONFIG_FC_MASK  0x0003  // Fault Count mask (bits 1:0) | 故障计数掩码(位1:0)

// Conversion Modes | 转换模式
#define OPT3006_MODE_SHUTDOWN    0x00  // Shutdown mode (lowest power) | 关断模式(最低功耗)
#define OPT3006_MODE_SINGLE_SHOT 0x01  // Single-shot conversion mode | 单次转换模式
#define OPT3006_MODE_CONTINUOUS  0x02  // Continuous conversion mode | 连续转换模式

// Conversion Time Settings | 转换时间设置
// CT位只有1位(位11): 0=100ms, 1=800ms
#define OPT3006_CT_100MS 0  // 100ms conversion time (bit 11 = 0) | 100ms转换时间(位11=0)
#define OPT3006_CT_800MS 1  // 800ms conversion time (bit 11 = 1) | 800ms转换时间(位11=1)

// Range Number Settings | 量程编号设置
#define OPT3006_RN_AUTO 0x0C  // Automatic full-scale range | 自动全量程

// Result Register Parsing | 结果寄存器解析
#define OPT3006_EXPONENT_SHIFT 12      // Exponent field shift (bits 15:12) | 指数字段偏移(位15:12)
#define OPT3006_MANTISSA_MASK  0x0FFF  // Mantissa mask (bits 11:0) | 尾数掩码(位11:0)
#define OPT3006_LUX_SCALE \
    0.01f  // Lux calculation scale factor | 照度计算比例因子
           // Formula: lux = 0.01 × 2^E × M
           // 公式: 照度 = 0.01 × 2^E × M
           // E = exponent (4 bits) | E = 指数(4位)
           // M = mantissa (12 bits) | M = 尾数(12位)

// Measurement Range | 测量范围
#define OPT3006_LUX_MIN 0.01f     // Minimum measurable lux | 最小可测照度
#define OPT3006_LUX_MAX 83865.6f  // Maximum measurable lux | 最大可测照度

// Timing Constants | 时序常数
#define OPT3006_STARTUP_TIME_MS  100  // Sensor startup time | 传感器启动时间
#define OPT3006_CONVERSION_100MS 110  // 100ms conversion + margin | 100ms转换+余量
#define OPT3006_CONVERSION_800MS 850  // 800ms conversion + margin | 800ms转换+余量

/**
 * @brief Initialize OPT3006 sensor | 初始化OPT3006传感器
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 * @note Configures I2C, verifies device ID, sets default config (continuous, 800ms, auto-range)
 * @note 配置I2C，验证设备ID，设置默认配置（连续模式，800ms，自动量程）
 */
int opt3006_init(void);

/**
 * @brief Check device ID | 检查设备ID
 * @return 0 if device ID matches OPT3006, negative error code otherwise
 * @return 设备ID匹配OPT3006返回0，否则返回负数错误码
 */
int opt3006_check_id(void);

/**
 * @brief Read illuminance value from sensor | 从传感器读取照度值
 * @param lux Pointer to store illuminance value (unit: lux) | 存储照度值的指针（单位：勒克斯）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 * @note Simple version, only returns lux value | 简化版本，只返回照度值
 * @note 适合一般使用
 */
int opt3006_read_lux(float* lux);

/**
 * @brief Read illuminance with optional raw data | 读取照度值，可选返回原始数据
 * @param lux Pointer to store illuminance value (required) | 照度值输出（必需）
 * @param raw_result Pointer to store raw 16-bit register value (optional, can be NULL)
 *                   原始16位寄存器值（可选，传NULL则不返回）
 * @param exponent Pointer to store exponent E[3:0] (optional, can be NULL)
 *                 指数E[3:0]（可选，传NULL则不返回）
 * @param mantissa Pointer to store mantissa R[11:0] (optional, can be NULL)
 *                 尾数R[11:0]（可选，传NULL则不返回）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 * @note Extended version for debugging - reads register only once | 扩展版本用于调试 - 只读一次寄存器
 * @note 用途：调试时需要查看原始数据
 */
int opt3006_read_lux_ex(float* lux, uint16_t* raw_result, uint8_t* exponent, uint16_t* mantissa);

/**
 * @brief Suspend i2c3 (OPT3006 bus) and pull P1.04/P1.05 low for sleep.
 * 挂起 i2c3（OPT3006 总线），并将 P1.04/P1.05 拉低用于休眠。
 */
void opt3006_prepare_for_sleep(void);

/**
 * @brief Set conversion mode | 设置转换模式
 * @param mode Conversion mode | 转换模式:
 *             - OPT3006_MODE_SHUTDOWN (0x00): Shutdown mode | 关断模式
 *             - OPT3006_MODE_SINGLE_SHOT (0x01): Single-shot mode | 单次转换模式
 *             - OPT3006_MODE_CONTINUOUS (0x02): Continuous mode | 连续转换模式
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int opt3006_set_mode(uint8_t mode);

/**
 * @brief Set conversion time | 设置转换时间
 * @param ct Conversion time | 转换时间:
 *           - OPT3006_CT_100MS (0): 100ms conversion | 100ms转换时间
 *           - OPT3006_CT_800MS (1): 800ms conversion (higher precision) | 800ms转换时间（更高精度）
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int opt3006_set_conversion_time(uint8_t ct);

/**
 * @brief Start single-shot conversion | 启动单次转换
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 * @note Sets mode to single-shot and starts conversion | 设置为单次模式并启动转换
 */
int opt3006_start_conversion(void);

/**
 * @brief Check if conversion is ready | 检查转换是否就绪
 * @return true if conversion is ready, false otherwise | 转换就绪返回true，否则返回false
 * @note Reads CRF (Conversion Ready Flag) from configuration register
 * @note 从配置寄存器读取CRF（转换就绪标志）
 */
bool opt3006_is_ready(void);

/**
 * @brief Get current configuration register value | 获取当前配置寄存器值
 * @param config Pointer to store configuration value | 存储配置值的指针
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int opt3006_get_config(uint16_t* config);

/**
 * @brief Set range number | 设置量程编号
 * @param rn Range number (0x00 - 0x0C) | 量程编号（0x00 - 0x0C）
 *           - 0x00-0x0B: Manual range setting | 手动量程设置
 *           - 0x0C: Automatic full-scale range | 自动全量程
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 */
int opt3006_set_range(uint8_t rn);

/**
 * @brief Read 16-bit register from OPT3006 (for debugging) | 从OPT3006读取16位寄存器（用于调试）
 * @param reg Register address (0x00-0x7F) | 寄存器地址（0x00-0x7F）
 * @param value Pointer to store read value | 存储读取值的指针
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 * @note Direct register access for advanced debugging | 直接寄存器访问用于高级调试
 */
int opt3006_read_reg(uint8_t reg, uint16_t* value);

/**
 * @brief Write 16-bit register to OPT3006 (for debugging) | 向OPT3006写入16位寄存器（用于调试）
 * @param reg Register address (0x00-0x7F) | 寄存器地址（0x00-0x7F）
 * @param value Value to write | 要写入的值
 * @return 0 on success, negative error code on failure | 成功返回0，失败返回负数错误码
 * @note Direct register access for advanced debugging | 直接寄存器访问用于高级调试
 * @warning Be careful not to write to read-only registers | 注意不要写入只读寄存器
 */
int opt3006_write_reg(uint8_t reg, uint16_t value);

/*
 * @brief Initialize OPT3006 | 初始化OPT3006
 */
int opt3006_initialize(void);
#endif /* MOS_OPT3006_H_ */