/***
 * @Author       : Cole
 * @Date         : 2025-07-31 11:56:20
 * @LastEditTime : 2025-07-31 17:11:44
 * @FilePath     : bspal_watchdog.h
 * @Description  :
 * @
 * @ Copyright (c) MentraOS Contributors 2025
 * @ SPDX-License-Identifier: Apache-2.0
 */

#ifndef BSPAL_WATCHDOG_H_
#define BSPAL_WATCHDOG_H_

void primary_feed_worker(void);

int bspal_watchdog_init(void);

#endif /* BSPAL_WATCHDOG_H_ */