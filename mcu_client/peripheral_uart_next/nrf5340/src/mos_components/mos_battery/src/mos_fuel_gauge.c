/*
 * @Author       : Cole
 * @Date         : 2025-07-31 10:40:40
 * @LastEditTime : 2025-07-31 16:37:26
 * @FilePath     : mos_fuel_gauge.c
 * @Description  : 
 *
 *  Copyright (c) MentraOS Contributors 2025
 *  SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/drivers/mfd/npm1300.h>
#include <zephyr/drivers/sensor/npm1300_charger.h>
#include <zephyr/sys/util.h>
#include <nrf_fuel_gauge.h>

#include "bsp_log.h"
#include "mos_fuel_gauge.h"

#define TAG "MOS_BATTERY"
/* nPM1300 CHARGER.BCHGCHARGESTATUS register bitmasks */
#define NPM1300_CHG_STATUS_COMPLETE_MASK BIT(1)
#define NPM1300_CHG_STATUS_TRICKLE_MASK BIT(2)
#define NPM1300_CHG_STATUS_CC_MASK BIT(3)
#define NPM1300_CHG_STATUS_CV_MASK BIT(4)
static const struct device *pmic = DEVICE_DT_GET(DT_NODELABEL(npm1300_ek_pmic));
static const struct device *charger = DEVICE_DT_GET(DT_NODELABEL(npm1300_ek_charger));
static volatile bool vbus_connected;

static int64_t ref_time;
static const struct battery_model battery_model = {
#include "battery_model.inc"
};

// 静态函数，用于读取传感器数据
static int read_sensors(const struct device *charger, float *voltage, float *current, float *temp,
						int32_t *chg_status)
{
	// 定义传感器值结构体
	struct sensor_value value;
	// 定义返回值
	int ret;

	// 从传感器中获取数据
	ret = sensor_sample_fetch(charger);
	// 如果获取失败，返回错误码
	if (ret < 0)
	{
		return ret;
	}

	// 从传感器中获取电压值
	sensor_channel_get(charger, SENSOR_CHAN_GAUGE_VOLTAGE, &value);
	// 将传感器值转换为浮点数
	*voltage = (float)value.val1 + ((float)value.val2 / 1000000);

	// 从传感器中获取温度值
	sensor_channel_get(charger, SENSOR_CHAN_GAUGE_TEMP, &value);
	// 将传感器值转换为浮点数
	*temp = (float)value.val1 + ((float)value.val2 / 1000000);

	// 从传感器中获取电流值
	sensor_channel_get(charger, SENSOR_CHAN_GAUGE_AVG_CURRENT, &value);
	// 将传感器值转换为浮点数
	*current = (float)value.val1 + ((float)value.val2 / 1000000);

	// 从传感器中获取充电状态值
	sensor_channel_get(charger, SENSOR_CHAN_NPM1300_CHARGER_STATUS, &value);
	// 将传感器值转换为整型
	*chg_status = value.val1;

	// 返回成功码
	return 0;
}

// 静态函数，用于通知充电状态
static int charge_status_inform(int32_t chg_status)
{
	// 定义一个联合体，用于存储充电状态信息
	union nrf_fuel_gauge_ext_state_info_data state_info;

	// 如果充电状态包含完成标志
	if (chg_status & NPM1300_CHG_STATUS_COMPLETE_MASK)
	{
		// 打印充电完成信息
		BSP_LOGI(TAG, "Charge complete");
		// 设置充电状态为完成
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_COMPLETE;
	}
	// 如果充电状态包含涓流充电标志
	else if (chg_status & NPM1300_CHG_STATUS_TRICKLE_MASK)
	{
		// 打印涓流充电信息
		BSP_LOGI(TAG, "Trickle charging");
		// 设置充电状态为涓流充电
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_TRICKLE;
	}
	// 如果充电状态包含恒流充电标志
	else if (chg_status & NPM1300_CHG_STATUS_CC_MASK)
	{
		// 打印恒流充电信息
		BSP_LOGI(TAG, "Constant current charging");
		// 设置充电状态为恒流充电
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_CC;
	}
	// 如果充电状态包含恒压充电标志
	else if (chg_status & NPM1300_CHG_STATUS_CV_MASK)
	{
		// 打印恒压充电信息
		BSP_LOGI(TAG, "Constant voltage charging");
		// 设置充电状态为恒压充电
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_CV;
	}
	// 否则，充电状态为空闲
	else
	{
		// 打印充电空闲信息
		BSP_LOGI(TAG, "Charger idle");
		// 设置充电状态为空闲
		state_info.charge_state = NRF_FUEL_GAUGE_CHARGE_STATE_IDLE;
	}

	// 更新充电状态信息
	return nrf_fuel_gauge_ext_state_update(NRF_FUEL_GAUGE_EXT_STATE_INFO_CHARGE_STATE_CHANGE,
										   &state_info);
}

int fuel_gauge_init(const struct device *charger)
{
	// 定义一个结构体变量value
	struct sensor_value value;
	// 定义一个结构体变量parameters，并初始化
	struct nrf_fuel_gauge_init_parameters parameters = {
		.model = &battery_model,
		.opt_params = NULL,
		.state = NULL,
	};
	// 定义三个浮点型变量，用于存储充电电流
	float max_charge_current;
	float term_charge_current;
	// 定义一个整型变量，用于存储充电状态
	int32_t chg_status;
	// 定义一个整型变量，用于存储返回值
	int ret;

	// 打印nRF Fuel Gauge的版本号
	BSP_LOGI(TAG, "nRF Fuel Gauge version: %s", nrf_fuel_gauge_version);

	// 读取传感器数据，并存储到parameters中
	ret = read_sensors(charger, &parameters.v0, &parameters.i0, &parameters.t0, &chg_status);
	if (ret < 0)
	{
		return ret;
	}

	/* Store charge nominal and termination current, needed for ttf calculation */
	// 获取充电电流，并存储到max_charge_current中
	sensor_channel_get(charger, SENSOR_CHAN_GAUGE_DESIRED_CHARGING_CURRENT, &value);
	max_charge_current = (float)value.val1 + ((float)value.val2 / 1000000);
	// 计算终止充电电流，并存储到term_charge_current中
	term_charge_current = max_charge_current / 10.f;

	// 初始化nRF Fuel Gauge
	ret = nrf_fuel_gauge_init(&parameters, NULL);
	if (ret < 0)
	{
		BSP_LOGE(TAG, "Error: Could not initialise fuel gauge");
		return ret;
	}

	// 设置nRF Fuel Gauge的充电电流限制
	ret = nrf_fuel_gauge_ext_state_update(NRF_FUEL_GAUGE_EXT_STATE_INFO_CHARGE_CURRENT_LIMIT,
										  &(union nrf_fuel_gauge_ext_state_info_data){
											  .charge_current_limit = max_charge_current});
	if (ret < 0)
	{
		BSP_LOGE(TAG, "Error: Could not set fuel gauge state");
		return ret;
	}

	// 设置nRF Fuel Gauge的终止充电电流
	ret = nrf_fuel_gauge_ext_state_update(NRF_FUEL_GAUGE_EXT_STATE_INFO_TERM_CURRENT,
										  &(union nrf_fuel_gauge_ext_state_info_data){
											  .charge_term_current = term_charge_current});
	if (ret < 0)
	{
		BSP_LOGE(TAG, "Error: Could not set fuel gauge state");
		return ret;
	}

	ret = charge_status_inform(chg_status);
	if (ret < 0)
	{
		BSP_LOGE(TAG, "Error: Could not set fuel gauge state");
		return ret;
	}

	ref_time = k_uptime_get();

	return 0;
}

int fuel_gauge_update(const struct device *charger, bool vbus_connected)
{
	// 声明一个静态变量，用于存储上一次的充电状态
	static int32_t chg_status_prev;

	// 声明变量，用于存储从充电器设备读取的电压、电流、温度、充电状态等信息
	float voltage;
	float current;
	float temp;
	float soc;
	float tte;
	float ttf;
	float delta;
	int32_t chg_status;
	int ret;

	// 从充电器设备读取电压、电流、温度、充电状态等信息
	ret = read_sensors(charger, &voltage, &current, &temp, &chg_status);
	if (ret < 0)
	{
		// 如果读取失败，打印错误信息并返回错误码
		BSP_LOGE(TAG, "Error: Could not read from charger device");
		return ret;
	}

	// 通知充电器设备当前的状态
	ret = nrf_fuel_gauge_ext_state_update(
		vbus_connected ? NRF_FUEL_GAUGE_EXT_STATE_INFO_VBUS_CONNECTED
					   : NRF_FUEL_GAUGE_EXT_STATE_INFO_VBUS_DISCONNECTED,
		NULL);
	if (ret < 0)
	{
		// 如果通知失败，打印错误信息并返回错误码
		BSP_LOGE(TAG, "Error: Could not inform of state");
		return ret;
	}

	// 如果充电状态发生了变化
	if (chg_status != chg_status_prev)
	{
		// 更新上一次的充电状态
		chg_status_prev = chg_status;

		// 通知充电状态
		ret = charge_status_inform(chg_status);
		if (ret < 0)
		{
			// 如果通知失败，打印错误信息并返回错误码
			BSP_LOGE(TAG, "Error: Could not inform of charge status");
			return ret;
		}
	}

	// 计算时间差
	delta = (float)k_uptime_delta(&ref_time) / 1000.0f;
	// 处理电池信息
	soc = nrf_fuel_gauge_process(voltage, current, temp, delta, NULL); // v -测量的电池电压[V]。 i -测量的电池电流[A]。 T -测量的电池温度[C]
	tte = nrf_fuel_gauge_tte_get();									   // 获取电池在当前放电条件下预计还能使用的时间
	ttf = nrf_fuel_gauge_ttf_get();									   // 获取电池在当前充电条件下预计还需多长时间才能充满

	// 打印电池信息
	BSP_LOGI(TAG, "V: %.3f, I: %.3f, T: %.2f, ", (double)voltage, (double)current, (double)temp);
	BSP_LOGI(TAG, "SoC: %.2f, TTE: %.0f, TTF: %.0f", (double)soc, (double)tte, (double)ttf);

	// 返回成功码
	return 0;
}
static void event_callback(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
	if (pins & BIT(NPM1300_EVENT_VBUS_DETECTED))
	{
		BSP_LOGE(TAG, "Vbus connected");
		vbus_connected = true;
	}

	if (pins & BIT(NPM1300_EVENT_VBUS_REMOVED))
	{
		BSP_LOGE(TAG, "Vbus removed");
		vbus_connected = false;
	}
}
int pm1300_init(void)
{
	int err = 0;
	// 检查pmic设备是否准备好
	if (!device_is_ready(pmic))
	{
		BSP_LOGE(TAG, "Pmic device not ready.");
		return -1;
	}

	// 检查充电器设备是否准备好
	if (!device_is_ready(charger))
	{
		BSP_LOGE(TAG, "Charger device not ready");
		return -1;
	}

	// 初始化电量计
	if (fuel_gauge_init(charger) < 0)
	{
		BSP_LOGE(TAG, "Could not initialise fuel gauge");
		return -1;
	}

	// 初始化gpio回调函数
	static struct gpio_callback event_cb;

	gpio_init_callback(&event_cb, event_callback,
					   BIT(NPM1300_EVENT_VBUS_DETECTED) |
						   BIT(NPM1300_EVENT_VBUS_REMOVED));

	// 添加pmic回调函数
	err = mfd_npm1300_add_callback(pmic, &event_cb);
	if (err)
	{
		BSP_LOGE(TAG, "Failed to add pmic callback");
		return -1;
	}

	struct sensor_value val;
	int ret = sensor_attr_get(charger, SENSOR_CHAN_CURRENT, SENSOR_ATTR_UPPER_THRESH, &val);
	if (ret < 0)
	{
		BSP_LOGI(TAG, "sensor_attr_get err[%d]!!!", ret);
		return -1;
	}
	vbus_connected = (val.val1 != 0) || (val.val2 != 0);
	fuel_gauge_update(charger, vbus_connected);

	BSP_LOGI(TAG, "PMIC device ok");
	return 0;
}

// 函数：电池监控
// 功能：更新充电器状态和Vbus连接状态
void batter_monitor(void)
{
	// 更新充电器状态和Vbus连接状态
	fuel_gauge_update(charger, vbus_connected);
}