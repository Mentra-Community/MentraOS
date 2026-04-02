/*
 * Copyright (c) MentraOS Contributors 2025
 * SPDX-License-Identifier: Apache-2.0
 */

#include "mos_fuel_gauge.h"
#include "protobuf_handler.h"  /* sync SoC & charging to display/BLE */
#include "mos_lvgl_display.h"  /* display_request_welcome_battery_refresh */

#include <nrf_fuel_gauge.h>
#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/drivers/mfd/npm1300.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/drivers/sensor/npm1300_charger.h>
#include <zephyr/sys/util.h>
#include <zephyr/logging/log.h>
#include <errno.h>

LOG_MODULE_REGISTER(mos_fuel_gauge, LOG_LEVEL_DBG);

/* nPM1300 CHARGER.BCHGCHARGESTATUS register bitmasks / nPM1300充电状态寄存器位掩码 */
#define NPM1300_CHG_STATUS_COMPLETE_MASK BIT(1)  /* Charge complete / 充电完成 */
#define NPM1300_CHG_STATUS_TRICKLE_MASK BIT(2)   /* Trickle charging / 涓流充电 */
#define NPM1300_CHG_STATUS_CC_MASK BIT(3)        /* Constant current / 恒流充电 */
#define NPM1300_CHG_STATUS_CV_MASK BIT(4)        /* Constant voltage / 恒压充电 */

/* Device pointers from device tree / 从设备树获取的设备指针 */
static const struct device *pmic = DEVICE_DT_GET(DT_NODELABEL(npm1300_ek_pmic));        /* PMIC device / PMIC设备 */
static const struct device *charger = DEVICE_DT_GET(DT_NODELABEL(npm1300_ek_charger)); /* Charger device / 充电器设备 */

static volatile bool vbus_connected;  /* VBUS connection status / VBUS连接状态 */
static int64_t ref_time;              /* Reference time for delta calculation / 用于计算时间差的参考时间 */

/* Periodic monitor (auto-start or shell "battery monitor start") */
static bool monitoring_active = false;
static bool work_initialized   = false;
static struct k_work_delayable monitor_work;

/* Boot fast poll: first run 200ms, then 300/500/1000ms (4 runs in ~2s) to catch charger ready. 上电快速轮询 */
#define BOOT_POLL_COUNT       3
static const uint32_t boot_poll_delays_ms[BOOT_POLL_COUNT] = { 300, 500, 1000 };
static int boot_poll_index = 0;

/* Battery model parameters / 电池模型参数 */
static const struct battery_model battery_model = {
// #include "battery_model.inc"
#include "GY051023C21250310k_25C.inc"
};

/**
 * @brief Read sensor data from charger device
 * 从充电器设备读取传感器数据
 * @param charger Pointer to charger device
 * @param voltage Pointer to store voltage value
 * @param current Pointer to store current value
 * @param temp Pointer to store temperature value
 * @param chg_status Pointer to store charge status
 * @return 0 on success, negative error code on failure
 */
static int read_sensors(const struct device *charger, float *voltage, float *current, float *temp,
			int32_t *chg_status)
{
	struct sensor_value value;
	int ret;

	/* Fetch sensor data from device / 从设备获取传感器数据 */
	ret = sensor_sample_fetch(charger);
	if (ret < 0)
	{
		return ret;
	}

	/* Read voltage: val1 is integer part, val2 is fractional part (micro units) / 读取电压：val1是整数部分，val2是小数部分（微单位） */
	sensor_channel_get(charger, SENSOR_CHAN_GAUGE_VOLTAGE, &value);
	*voltage = (float)value.val1 + ((float)value.val2 / 1000000);

	/* Read temperature / 读取温度 */
	sensor_channel_get(charger, SENSOR_CHAN_GAUGE_TEMP, &value);
	*temp = (float)value.val1 + ((float)value.val2 / 1000000);

	/* Read average current / 读取平均电流 */
	sensor_channel_get(charger, SENSOR_CHAN_GAUGE_AVG_CURRENT, &value);
	*current = (float)value.val1 + ((float)value.val2 / 1000000);

	/* Read charge status / 读取充电状态 */
	sensor_channel_get(charger, SENSOR_CHAN_NPM1300_CHARGER_STATUS, &value);
	*chg_status = value.val1;

	return 0;
}

/**
 * @brief Inform fuel gauge of charge status change
 * 通知电量计充电状态变化
 * @param chg_status Charge status from charger
 * @return 0 on success, negative error code on failure
 */
static int charge_status_inform(int32_t chg_status)
{
	union nrf_fuel_gauge_ext_state_info_data state_info;

	/* Check charge status and update fuel gauge accordingly / 检查充电状态并相应更新电量计 */
	if (chg_status & NPM1300_CHG_STATUS_COMPLETE_MASK)
	{
		LOG_INF("Charge complete");
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_COMPLETE;
	}
	else if (chg_status & NPM1300_CHG_STATUS_TRICKLE_MASK)
	{
		LOG_INF("Trickle charging");
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_TRICKLE;
	}
	else if (chg_status & NPM1300_CHG_STATUS_CC_MASK)
	{
		LOG_INF("Constant current charging");
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_CC;
	}
	else if (chg_status & NPM1300_CHG_STATUS_CV_MASK)
	{
		LOG_INF("Constant voltage charging");
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_CV;
	}
	else
	{
		/* Charger is idle / 充电器空闲 */
		LOG_INF("Charger idle");
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_IDLE;
	}

	/* Update fuel gauge with charge state change / 更新电量计的充电状态变化 */
	return nrf_fuel_gauge_ext_state_update(NRF_FUEL_GAUGE_EXT_STATE_INFO_CHARGE_STATE_CHANGE,
					       &state_info);
}

int fuel_gauge_init(const struct device *charger)
{
	struct sensor_value value;
	/* Initialize fuel gauge parameters / 初始化电量计参数 */
	struct nrf_fuel_gauge_init_parameters parameters = {
		.model = &battery_model,    /* Battery model data / 电池模型数据 */
		.opt_params = NULL,          /* Optional parameters / 可选参数 */
		.state = NULL,               /* Initial state / 初始状态 */
	};
	float max_charge_current;      /* Maximum charge current / 最大充电电流 */
	float term_charge_current;     /* Termination charge current (10% of max) / 终止充电电流（最大值的10%） */
	int32_t chg_status;            /* Charge status / 充电状态 */
	int ret;

	LOG_INF("nRF Fuel Gauge version: %s", nrf_fuel_gauge_version);

	/* Read initial sensor values: voltage, current, temperature, charge status / 读取初始传感器值：电压、电流、温度、充电状态 */
	ret = read_sensors(charger, &parameters.v0, &parameters.i0, &parameters.t0, &chg_status);
	if (ret < 0)
	{
		return ret;
	}

	/* Get charge current parameters / 获取充电电流参数 */
	sensor_channel_get(charger, SENSOR_CHAN_GAUGE_DESIRED_CHARGING_CURRENT, &value);
	max_charge_current = (float)value.val1 + ((float)value.val2 / 1000000);
	/* Termination current is 10% of max charge current / 终止电流为最大充电电流的10% */
	term_charge_current = max_charge_current / 10.f;

	/* Initialize fuel gauge library with battery model and initial readings / 使用电池模型和初始读数初始化电量计库 */
	ret = nrf_fuel_gauge_init(&parameters, NULL);
	if (ret < 0)
	{
		LOG_ERR("Error: Could not initialise fuel gauge");
		return ret;
	}

	/* Set maximum charge current limit / 设置最大充电电流限制 */
	ret = nrf_fuel_gauge_ext_state_update(NRF_FUEL_GAUGE_EXT_STATE_INFO_CHARGE_CURRENT_LIMIT,
					      &(union nrf_fuel_gauge_ext_state_info_data){
						      .charge_current_limit = max_charge_current});
	if (ret < 0)
	{
		LOG_ERR("Error: Could not set fuel gauge state");
		return ret;
	}

	/* Set termination current for full charge detection / 设置终止电流用于满充检测 */
	ret = nrf_fuel_gauge_ext_state_update(NRF_FUEL_GAUGE_EXT_STATE_INFO_TERM_CURRENT,
					      &(union nrf_fuel_gauge_ext_state_info_data){
						      .charge_term_current = term_charge_current});
	if (ret < 0)
	{
		LOG_ERR("Error: Could not set fuel gauge state");
		return ret;
	}

	/* Inform fuel gauge of initial charge status / 通知电量计初始充电状态 */
	ret = charge_status_inform(chg_status);
	if (ret < 0)
	{
		LOG_ERR("Error: Could not set fuel gauge state");
		return ret;
	}

	/* Store reference time for delta calculation in updates / 存储参考时间用于更新时计算时间差 */
	ref_time = k_uptime_get();

	return 0;
}

int fuel_gauge_update(const struct device *charger, bool vbus_connected)
{
	static int32_t chg_status_prev;
	float voltage;    /* Battery voltage / 电池电压 */
	float current;    /* Battery current / 电池电流 */
	float temp;       /* Battery temperature / 电池温度 */
	float soc;        /* State of charge / 电量百分比 */
	float tte;        /* Time to empty / 耗尽时间 */
	float ttf;       /* Time to full / 充满时间 */
	float delta;      /* Time delta / 时间差 */
	int32_t chg_status;
	int ret;

	/* Read current sensor values / 读取当前传感器值 */
	ret = read_sensors(charger, &voltage, &current, &temp, &chg_status);
	if (ret < 0)
	{
		LOG_ERR("Error: Could not read from charger device");
		return ret;
	}

	/* Update VBUS connection status in fuel gauge / 更新电量计中的VBUS连接状态 */
	ret = nrf_fuel_gauge_ext_state_update(
		vbus_connected ? NRF_FUEL_GAUGE_EXT_STATE_INFO_VBUS_CONNECTED
			       : NRF_FUEL_GAUGE_EXT_STATE_INFO_VBUS_DISCONNECTED,
		NULL);
	if (ret < 0)
	{
		LOG_ERR("Error: Could not inform of state");
		return ret;
	}

	/* Only update charge status if it has changed / 仅在充电状态改变时更新 */
	if (chg_status != chg_status_prev)
	{
		chg_status_prev = chg_status;
		ret = charge_status_inform(chg_status);
		if (ret < 0)
		{
			LOG_ERR("Error: Could not inform of charge status");
			return ret;
		}
	}

	/* Calculate time delta since last update (in seconds) / 计算自上次更新以来的时间差（秒） */
	delta = (float)k_uptime_delta(&ref_time) / 1000.0f;
	
	/* Process fuel gauge algorithm with current measurements / 使用当前测量值处理电量计算法 */
	/* Parameters: voltage(V), current(A), temp(C), delta(s) / 参数：电压(V)、电流(A)、温度(C)、时间差(s) */
	soc = nrf_fuel_gauge_process(voltage, current, temp, delta, NULL);
	
	/* Get estimated times from fuel gauge / 从电量计获取估算时间 */
	tte = nrf_fuel_gauge_tte_get();  /* Time to empty in seconds / 耗尽时间（秒） */
	ttf = nrf_fuel_gauge_ttf_get();  /* Time to full in seconds / 充满时间（秒） */

	LOG_INF("V: %.3f, I: %.3f, T: %.2f, ", (double)voltage, (double)current, (double)temp);
	LOG_INF("SoC: %.2f%%, TTE(s): %.0f, TTF(s): %.0f,", (double)soc, (double)tte, (double)ttf);
	{
		uint32_t pct = (uint32_t)(soc + 0.5f);
		if (pct > 100)
		{
			pct = 100;
		}
		protobuf_set_battery_level(pct);
	}
	{
		bool charging = (chg_status & (NPM1300_CHG_STATUS_TRICKLE_MASK | NPM1300_CHG_STATUS_CC_MASK | NPM1300_CHG_STATUS_CV_MASK)) != 0;
		protobuf_set_charging_state(charging);
	}

	return 0;
}

/**
 * @brief PMIC event callback for VBUS detection
 * PMIC VBUS检测事件回调
 * @param dev Device pointer
 * @param cb GPIO callback structure
 * @param pins Pin mask of triggered events
 */
static void event_callback(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
	if (pins & BIT(NPM1300_EVENT_VBUS_DETECTED))
	{
		LOG_INF("Vbus connected");
		vbus_connected = true;
	}

	if (pins & BIT(NPM1300_EVENT_VBUS_REMOVED))
	{
		LOG_INF("Vbus removed");
		vbus_connected = false;
	}
}

int pm1300_init(void)
{
	int err = 0;

	/* Check device readiness / 检查设备就绪状态 */
	if (!device_is_ready(pmic))
	{
		LOG_ERR("Pmic device not ready.");
		return -1;
	}

	if (!device_is_ready(charger))
	{
		LOG_ERR("Charger device not ready");
		return -1;
	}

	/* Initialize fuel gauge / 初始化电量计 */
	if (fuel_gauge_init(charger) < 0)
	{
		LOG_ERR("Could not initialise fuel gauge");
		return -1;
	}

	/* Setup GPIO callback for VBUS events / 设置VBUS事件GPIO回调 */
	static struct gpio_callback event_cb;

	gpio_init_callback(&event_cb, event_callback,
			   BIT(NPM1300_EVENT_VBUS_DETECTED) | BIT(NPM1300_EVENT_VBUS_REMOVED));

	err = mfd_npm1300_add_callback(pmic, &event_cb);
	if (err)
	{
		LOG_ERR("Failed to add pmic callback");
		return -1;
	}

	/* Check initial VBUS status by reading current threshold / 通过读取电流阈值检查初始VBUS状态 */
	struct sensor_value val;
	int ret = sensor_attr_get(charger, SENSOR_CHAN_CURRENT, SENSOR_ATTR_UPPER_THRESH, &val);
	if (ret < 0)
	{
		LOG_INF("sensor_attr_get err[%d]", ret);
		return -1;
	}
	/* If current threshold is non-zero, VBUS is connected / 如果电流阈值非零，则VBUS已连接 */
	vbus_connected = (val.val1 != 0) || (val.val2 != 0);
	
	/* Perform initial fuel gauge update / 执行初始电量计更新 */
	fuel_gauge_update(charger, vbus_connected);

	LOG_INF("PMIC device ok");
	return 0;
}

void battery_monitor(void)
{
	if (!device_is_ready(charger))
	{
		LOG_ERR("Charger device not ready for battery monitor / 充电器设备未就绪，无法进行电池监控");
		return;
	}
	fuel_gauge_update(charger, vbus_connected);
}

int battery_get_charge_status(int32_t *chg_status)
{
	struct sensor_value value;
	int ret;

	if (chg_status == NULL)
	{
		return -EINVAL;
	}

	if (!device_is_ready(charger))
	{
		return -ENODEV;
	}

	/* Read charge status from charger / 从充电器读取充电状态 */
	ret = sensor_sample_fetch(charger);
	if (ret < 0)
	{
		return ret;
	}

	sensor_channel_get(charger, SENSOR_CHAN_NPM1300_CHARGER_STATUS, &value);
	*chg_status = value.val1;

	return 0;
}


/**
 * Work handler: read SoC + charging, refresh display; then reschedule (boot fast poll or 5s).
 * 工作处理：读取电量与充电状态、刷新界面；然后再次调度（上电快速轮询或 5s 周期）。
 */
static void battery_monitor_work_handler(struct k_work *work)
{
	if (!monitoring_active)
	{
		return;
	}
	LOG_INF("Battery monitor update... / 电池监控更新中...");
	battery_monitor();
	display_request_welcome_battery_refresh();

	if (boot_poll_index < BOOT_POLL_COUNT)
	{
		uint32_t delay_ms = boot_poll_delays_ms[boot_poll_index];
		boot_poll_index++;
		(void)k_work_schedule((struct k_work_delayable *)work, K_MSEC(delay_ms));
	}
	else
	{
		(void)k_work_schedule((struct k_work_delayable *)work, K_MSEC(BATTERY_MONITOR_INTERVAL_MS));
	}
}

/**
 * Auto-start: one immediate read + display refresh, then boot fast poll (200/300/500/1000 ms), then 5s.
 * 上电自动启动：立即读一次并刷新界面，再在 200/300/500/1000 ms 内快速轮询 4 次，之后每 5s。
 */
void battery_monitor_auto_start(void)
{
	if (monitoring_active)
	{
		return;
	}
	/* One immediate read and refresh; if charger not ready yet, boot poll will retry.
	 立即读一次并刷新；若 charger 未就绪则由快速轮询重试 */
	battery_monitor();
	display_request_welcome_battery_refresh();

	if (!work_initialized)
	{
		k_work_init_delayable(&monitor_work, battery_monitor_work_handler);
		work_initialized = true;
	}
	monitoring_active = true;
	boot_poll_index = 0;
	/* First run in 200 ms (boot fast poll). 首次 200 ms 后执行（上电快速轮询） */
	(void)k_work_schedule(&monitor_work, K_MSEC(200));
}

void battery_monitor_start(void)
{
	if (monitoring_active)
	{
		return;
	}
	if (!work_initialized)
	{
		k_work_init_delayable(&monitor_work, battery_monitor_work_handler);
		work_initialized = true;
	}
	monitoring_active = true;
	boot_poll_index = BOOT_POLL_COUNT;  /* Skip boot fast poll when started from shell. Shell 启动时跳过快速轮询 */
	(void)k_work_schedule(&monitor_work, K_MSEC(BATTERY_MONITOR_INTERVAL_MS));
}

void battery_monitor_stop(void)
{
	monitoring_active = false;
	k_work_cancel_delayable(&monitor_work);
}

bool battery_monitor_is_active(void)
{
	return monitoring_active;
}
