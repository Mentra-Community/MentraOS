/*
 * @Author       : Cole
 * @Date         : 2026-01-30 09:47:30
 * @LastEditTime : 2026-01-30 10:00:11
 * @FilePath     : mos_usb_detect.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */


#include "mos_usb_detect.h"
#include "mos_jlink_usb_switch_app.h"

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <hal/nrf_usbreg.h>

LOG_MODULE_REGISTER(mos_usb_detect, LOG_LEVEL_INF);

#define USB_DETECT_POLL_INTERVAL_MS 1000 /* Poll every 1 second | 每1秒轮询一次 */

static struct k_work_delayable usb_detect_work;
static bool usb_connected = false;

/**
 * @brief USB cable connected callback | USB线缆连接回调
 */
static void usb_cable_connected(void)
{
	LOG_INF("🔌 USB cable connected / USB线缆已连接");
	usb_connected = true;

	int ret = mos_jlink_usb_switch_app_set_by_usb_status(true);
	if (ret != 0)
	{
		LOG_ERR("Failed to set J-Link/USB switch to USB mode: %d", ret);
	}
}

/**
 * @brief USB cable disconnected callback | USB线缆断开回调
 */
static void usb_cable_disconnected(void)
{
	LOG_INF("🔌 USB cable disconnected / USB线缆已断开");
	usb_connected = false;

	int ret = mos_jlink_usb_switch_app_set_by_usb_status(false);
	if (ret != 0)
	{
		LOG_ERR("Failed to set J-Link/USB switch to J-Link mode: %d", ret);
	}
}

/**
 * @brief USB detection work handler (polling mode) | USB检测工作处理（轮询模式）
 */
static void usb_detect_work_handler(struct k_work *work)
{
	uint32_t status = nrf_usbreg_status_get(NRF_USBREGULATOR_NS);
	bool current_vbus = (status & NRF_USBREG_STATUS_VBUSDETECT_MASK) != 0;

	if (current_vbus && !usb_connected)
	{
		usb_cable_connected();
	}
	else if (!current_vbus && usb_connected)
	{
		usb_cable_disconnected();
	}

	k_work_schedule(&usb_detect_work, K_MSEC(USB_DETECT_POLL_INTERVAL_MS));
}

int usb_detect_init(void)
{
	LOG_INF("🔌 Initializing USB cable detection (polling mode)");
	LOG_INF("Polling interval: %d ms / 轮询间隔: %d毫秒",
		USB_DETECT_POLL_INTERVAL_MS, USB_DETECT_POLL_INTERVAL_MS);

	k_work_init_delayable(&usb_detect_work, usb_detect_work_handler);

	uint32_t status = nrf_usbreg_status_get(NRF_USBREGULATOR_NS);

	if (status & NRF_USBREG_STATUS_VBUSDETECT_MASK)
	{
		usb_connected = true;
		LOG_INF("🔌 USB cable already connected / USB线缆已连接");
		int ret = mos_jlink_usb_switch_app_set_by_usb_status(true);
		if (ret != 0)
		{
			LOG_ERR("Failed to set J-Link/USB switch to USB mode: %d", ret);
		}
	}
	else
	{
		usb_connected = false;
		LOG_INF("🔌 USB cable not connected / USB线缆未连接");
		int ret = mos_jlink_usb_switch_app_set_by_usb_status(false);
		if (ret != 0)
		{
			LOG_ERR("Failed to set J-Link/USB switch to J-Link mode: %d", ret);
		}
	}

	k_work_schedule(&usb_detect_work, K_MSEC(USB_DETECT_POLL_INTERVAL_MS));

	LOG_INF("✅ USB detection started / USB检测已启动");

	return 0;
}

bool usb_is_connected(void)
{
	return usb_connected;
}
