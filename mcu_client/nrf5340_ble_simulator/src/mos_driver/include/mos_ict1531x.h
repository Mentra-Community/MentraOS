#ifndef MOS_ICT1531X_H_
#define MOS_ICT1531X_H_

#include <stddef.h>
#include <stdint.h>

#define ICT1531X_I2C_ADDR               0x1e
#define ICT1531X_REG_MANUF_ID           0x00
#define ICT1531X_REG_CHIP_ID            0x01 // ICP1531x expected chip ID register address;ICT1531x预期的芯片ID寄存器地址
#define ICT1531X_MANUF_ID_VAL           0xe7 // ICT1531x expected manufacturer ID;ICT1531x预期的制造商ID
#define ICT1531X_WHO_AM_I_VAL           0x45 // ICT1531x expected chip ID;ICT1531x预期的芯片ID
#define ICT1531X_REG_MODE_CTRL          0x04
#define ICT1531X_MODE_CTRL_MODE_MASK    0x03
#define ICT1531X_MODE_CTRL_MODE_STANDBY 0x00

int ict1531x_init(void);
int ict1531x_sleep(void);
int ict1531x_read_register(uint8_t reg, uint8_t *buf, size_t len);
int ict1531x_write_register(uint8_t reg, const uint8_t *buf, size_t len);
int ict1531x_read_manuf_id(uint8_t *manuf_id);
int ict1531x_read_device_id(uint8_t *device_id);

#endif /* MOS_ICT1531X_H_ */
