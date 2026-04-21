#ifndef MOS_I2S_SLAVE_H_
#define MOS_I2S_SLAVE_H_

#include <stdbool.h>
#include <stdint.h>
/***
 * @brief  Initialize I2S slave
 * @return 0 on success, error code otherwise
 */
int gx8002_i2s_init(void);
/***
 * @brief  Start I2S slave
 * @return 0 on success, error code otherwise
 */
int gx8002_i2s_start(void);
/***
 * @brief  Stop I2S slave
 * @return 0 on success, error code otherwise
 */
int gx8002_i2s_stop(void);
/***
 * @brief  Check if I2S slave is started
 * @return true if started, false otherwise
 */
bool gx8002_i2s_is_started(void);

#endif /* MOS_I2S_SLAVE_H_ */
