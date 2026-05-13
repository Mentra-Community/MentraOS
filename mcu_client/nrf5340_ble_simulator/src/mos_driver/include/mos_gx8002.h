
#ifndef MOS_GX8002_H_
#define MOS_GX8002_H_

#include <stdbool.h>
#include <stdint.h>
#define MOS_GX_DATA_ADDR                0x36
#define MOS_GX_CMD_ADDR                 0x2F
#define GX8002_REG_DMIC_GAIN            0xAC
#define GX8002_REG_CMD                  0xC4
#define GX8002_CMD_SET_DMIC_GAIN        0x73
#define GX8002_DMIC_GAIN_MAX            48
/* After writing 0x73 to 0xC4, chip may set 0xAC result flag asynchronously; wait then poll. */
#define GX8002_DMIC_GAIN_APPLY_DELAY_MS       50
#define GX8002_DMIC_GAIN_STATUS_POLL_TOTAL_MS 200
#define GX8002_DMIC_GAIN_STATUS_POLL_STEP_MS  10
int mos_gx8002_init(void);
void mos_gx8002_reset(void);
int mos_gx8002_power_control(bool enable);
uint8_t mos_gx8002_getversion(uint8_t *version);
uint8_t mos_gx8002_handshake(void);
uint8_t mos_gx8002_start_i2s(void);
uint8_t mos_gx8002_enable_i2s(void);
uint8_t mos_gx8002_disable_i2s(void);
uint8_t mos_gx8002_get_mic_state(uint8_t *state);
uint8_t mos_gx8002_set_dmic_gain(uint8_t gain, uint8_t *apply_status);
uint8_t mos_gx8002_is_i2s_enabled(void);

uint8_t mos_gx8002_iic_write_data(uint8_t slave_address, uint8_t *buf, int buf_len);
uint8_t mos_gx8002_iic_read_data(uint8_t slave_address, uint8_t reg, uint8_t *data);
uint8_t mos_gx8002_iic_wait_reply(uint8_t slave_address, uint8_t reg, uint8_t reply, int timeout_ms);

int mos_gx8002_vad_int_re_enable(void);
int mos_gx8002_vad_int_disable(void);

#endif /* MOS_GX8002_H_ */
