
#ifndef MOS_ICM45608_H_
#define MOS_ICM45608_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ICM45608_I2C_ADDR_0                     0x68
#define ICM45608_I2C_ADDR_1                     0x69

#define ICM45608_REG_WHO_AM_I                   0x72
#define ICM45608_WHO_AM_I_VAL                   0x81

#define ICM45608_I2C_SPEED                      I2C_SPEED_FAST
#define ICM45608_POWER_ON_DELAY_MS              20
#define ICM45608_SCL_PIN                        30
#define ICM45608_SDA_PIN                        31
#define ICM45608_REG_ACCEL_DATA_X1              0x00 // 14 bytes accel(6) gyro(6) temp(2)
#define ICM45608_REG_PWR_MGMT0                  0x10 // also controls gyro/accel low noise mode；设置加速度计和陀螺仪的低噪声模式
#define ICM45608_REG_ACCEL_CONFIG0              0x1b 
#define ICM45608_REG_GYRO_CONFIG0               0x1c
#define ICM45608_REG_IOC_PAD_SCENARIO_AUX_OVRD  0x30 // aux i2c master mode control;辅助I2C主模式控制
#define ICM45608_REG_REG_MISC1                  0x35 // osc id;振荡器ID
#define ICM45608_REG_IREG_ADDR_15_8             0x7c // register address for indirect register access;间接寄存器访问的寄存器地址
#define ICM45608_REG_IREG_DATA                  0x7e // data register for indirect register access;间接寄存器访问的数据寄存器
#define ICM45608_ACCEL_GYRO_TEMP_LEN            14   // accel(6) gyro(6) temp(2)
#define ICM45608_ACCEL_FSR_G                    4.0f // 4g full scale range;4g满量程范围
#define ICM45608_GYRO_FSR_DPS                   2000.0f // 2000 dps full scale range;2000度每秒满量程范围
#define ICM45608_STANDARD_GRAVITY               9.80665f // standard gravity for accel unit conversion;加速度单位转换的标准重力
#define ICM45608_ACCEL_CONFIG_50HZ_4G           0x3a    // 50Hz ODR, 4g FSR;50Hz输出数据率，4g满量程范围
#define ICM45608_GYRO_CONFIG_50HZ_2000DPS       0x1a    // 50Hz ODR, 2000dps FSR;50Hz输出数据率，2000度每秒满量程范围
#define ICM45608_SENSOR_STARTUP_DELAY_MS        80      // sensor startup delay;传感器启动延迟
#define ICM45608_INVALID_SENSOR_RAW             ((int16_t)0x8000)
#define ICM45608_PWR_MGMT0_ACCEL_GYRO_LN        0x0f // accel/gyro low noise mode;加速度计/陀螺仪低噪声模式
#define ICM45608_PWR_MGMT0_ACCEL_GYRO_MODE_MASK 0x0f // accel/gyro mode bits mask;加速度计/陀螺仪模式位掩码
#define ICM45608_PWR_MGMT0_ACCEL_GYRO_OFF       0x00 // accel/gyro off mode;加速度计/陀螺仪关闭模式
#define ICM45608_AUX1_MODE_OVRD_VAL_MASK        0x0c // aux1 mode override value mask;辅助1模式覆盖值掩码
#define ICM45608_AUX1_MODE_OVRD_VAL_I2CM        0x04 // aux1 mode override value for I2CM;辅助1模式覆盖值为I2CM
#define ICM45608_AUX1_MODE_OVRD_ENABLE          0x10 // aux1 mode override enable bit;辅助1模式覆盖使能位
#define ICM45608_REG_MISC1_OSC_ID_MASK          0x0f // osc id mask;振荡器ID掩码
#define ICM45608_REG_MISC1_OSC_ID_RCOSC         0x02 // osc id value for RC oscillator;RC振荡器的振荡器ID值
#define ICM45608_MREG_IO_DELAY_US               4    
#define ICM45608_MREG_I2CM_COMMAND_0            0xa206 
#define ICM45608_MREG_I2CM_DEV_PROFILE0         0xa20e 
#define ICM45608_MREG_I2CM_DEV_PROFILE1         0xa20f
#define ICM45608_MREG_I2CM_CONTROL              0xa216 // control register to start I2CM transaction;启动I2CM事务的控制寄存器
#define ICM45608_MREG_I2CM_STATUS               0xa218
#define ICM45608_MREG_I2CM_RD_DATA0             0xa21b
#define ICM45608_MREG_I2CM_WR_DATA0             0xa233
#define ICM45608_MREG_FIFO_SRAM_SLEEP           0xa2a7
#define ICM45608_I2CM_COMMAND_BURSTLEN_MASK     0x0f
#define ICM45608_I2CM_COMMAND_READ              BIT(4)
#define ICM45608_I2CM_COMMAND_END               BIT(7)
#define ICM45608_I2CM_CONTROL_GO                0x01
#define ICM45608_I2CM_CONTROL_SPEED_SLOW        BIT(3)
#define ICM45608_I2CM_STATUS_BUSY               BIT(0)
#define ICM45608_I2CM_STATUS_DONE               BIT(1)
#define ICM45608_I2CM_STATUS_ERROR_MASK         (BIT(2) | BIT(3) | BIT(4) | BIT(5))
#define ICM45608_I2CM_TIMEOUT_MS                50
#define ICM45608_I2CM_MAX_READ_LEN              21
#define ICM45608_I2CM_MAX_WRITE_LEN             5
#define ICM45608_FIFO_SRAM_SLEEP_MASK           0x03
#define ICM45608_FIFO_SRAM_POWER_DOWN           0x00
#define ICM45608_FIFO_SRAM_POWER_UP             0x03
typedef struct
{
    int16_t accel_raw[3];
    int16_t gyro_raw[3];
    int16_t temp_raw;
    float accel_g[3];
    float gyro_dps[3];
    float temp_degc;
} icm45608_sample_t;

int icm45608_init(void);
bool icm45608_is_ready(void);

int icm45608_read_device_id(uint8_t *device_id);
int icm45608_i2cm_read_reg(uint8_t i2c_addr, uint8_t reg, uint8_t *buf, size_t len);
int icm45608_i2cm_write_reg(uint8_t i2c_addr, uint8_t reg, const uint8_t *buf, size_t len);
int icm45608_read_register(uint8_t reg, uint8_t *value);
int icm45608_read_registers(uint8_t reg, uint8_t *buf, size_t len);
int icm45608_write_register(uint8_t reg, uint8_t value);

uint16_t icm45608_get_i2c_addr(void);

int icm45608_sleep(void);
int icm45608_wake(void);

int icm45608_read_sample(icm45608_sample_t *sample);
int icm45608_read_all(float *accel_x, float *accel_y, float *accel_z,
                      float *gyro_x, float *gyro_y, float *gyro_z);

#endif /* MOS_ICM45608_H_ */
