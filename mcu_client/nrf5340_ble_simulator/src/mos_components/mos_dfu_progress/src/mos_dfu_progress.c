/*
 * @Author       : Cole
 * @Date         : 2026-01-31 09:40:16
 * @LastEditTime : 2026-01-31 09:41:05
 * @FilePath     : mos_dfu_progress.c
 * @Description  : 
 * 
 *  Copyright (c) MentraOS Contributors 2026 
 *  SPDX-License-Identifier: Apache-2.0
 */


#include <stdio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#if IS_ENABLED(CONFIG_MCUMGR_GRP_IMG_UPLOAD_CHECK_HOOK) || IS_ENABLED(CONFIG_MCUMGR_GRP_IMG_STATUS_HOOKS)
#include <zephyr/mgmt/mcumgr/mgmt/callbacks.h>
#include <zephyr/mgmt/mcumgr/grp/img_mgmt/img_mgmt.h>
#include <zephyr/mgmt/mcumgr/grp/img_mgmt/img_mgmt_callbacks.h>
#include <zephyr/mgmt/mcumgr/mgmt/mgmt.h>
#endif

#include "mos_lvgl_display.h"

LOG_MODULE_REGISTER(mos_dfu_progress, LOG_LEVEL_INF);

/* 约每 8 KB 更新一次进度条/log，便于看到进度变化 | Update progress bar/log every ~8 KB so bar moves visibly */
#define DFU_PROGRESS_UPDATE_STEP_KB  8
#define DFU_BUF_LEN                   (MAX_TEXT_LEN + 1)

#if IS_ENABLED(CONFIG_MCUMGR_GRP_IMG_UPLOAD_CHECK_HOOK)

static size_t dfu_last_displayed_kb;
static bool   dfu_in_progress;
/* 首包或协议中的镜像总大小，0 表示未知 | Total image size from first packet or protocol, 0 = unknown */
static size_t dfu_total_bytes;

/* 根据已传/总字节算百分比 0..100 | Compute percent 0..100 from bytes_done/total_bytes */
static unsigned int dfu_compute_percent(size_t bytes_done, size_t total_bytes)
{
	if (total_bytes == 0 || bytes_done > total_bytes)
	{
		return 0;
	}
	unsigned int pct = (unsigned int)((bytes_done * 100U) / total_bytes);
	return pct > 100 ? 100 : pct;
}

/* 更新电量下方一行 DFU 状态文字 + 进度条用同一个 % + 打 log；进度条只显示文字里的 % | Update status line and bar with same %, log; bar shows the % from the text */
static void dfu_update_display_and_log(size_t bytes_done_kb, size_t bytes_done, size_t total_bytes)
{
	char buf[DFU_BUF_LEN];
	unsigned int pct = dfu_compute_percent(bytes_done, total_bytes);

	if (total_bytes > 0 && bytes_done <= total_bytes)
	{
		snprintf(buf, sizeof(buf), "DFU Updating... %u%% (%u KB)", pct, (unsigned int)bytes_done_kb);
	}
	else
	{
		snprintf(buf, sizeof(buf), "DFU Updating... %u KB", (unsigned int)bytes_done_kb);
	}
	display_update_dfu_status_text(buf);
	/* 进度条用与上面文字相同的 % 显示 | Progress bar uses same % as text above */
	display_update_dfu_progress(1, (uint8_t)pct);
	LOG_INF("DFU progress: %s", buf);
}

/* 返回 MGMT_CB_OK 允许本包上传；同时按 KB 节流推屏、打 log（含 %）
| Return MGMT_CB_OK to allow chunk; throttle, show KB and % */
static enum mgmt_cb_return dfu_chunk_cb(uint32_t event, enum mgmt_cb_return prev_status,
					 int32_t *rc, uint16_t *group_id, bool *abort_more,
					 void *data, size_t data_size)
{
	const struct img_mgmt_upload_check *check = (const struct img_mgmt_upload_check *)data;
	size_t off, size, bytes_done, bytes_done_kb;

	ARG_UNUSED(event);
	ARG_UNUSED(prev_status);
	ARG_UNUSED(rc);
	ARG_UNUSED(group_id);
	ARG_UNUSED(abort_more);
	ARG_UNUSED(data_size);

	if (!check || !check->req)
	{
		return MGMT_CB_OK;
	}

	off = check->req->off;
	size = check->req->size;
	/* 已传字节 = 当前偏移 + 本块数据长度（img_data.len）；首包时 size 常为镜像总长
	| bytes_done = off + this chunk len (img_data.len); first packet size = total */
	if (check->req->img_data.len > 0)
	{
		bytes_done = off + check->req->img_data.len;
	}
	else
	{
		bytes_done = off + size;
	}
	bytes_done_kb = bytes_done / 1024;

	/* 首包时 SMP 通常传总大小（size = 镜像总长），用于算 %
	| First packet: SMP usually sends total (size = image length) for % */
	if (off == 0 && size > 0)
	{
		dfu_total_bytes = size;
	}
	/* 若已传超过“总大小”，说明 size 实为本块长度，清空只显示 KB
	| If bytes_done > total, size was chunk len, clear to show KB only */
	if (dfu_total_bytes > 0 && bytes_done > dfu_total_bytes)
	{
		dfu_total_bytes = 0;
	}

	/* 每约 8 KB 或首包更新状态文字 + 进度条（同一 %）+ log；进度条只跟文字里的 % 走 | Update status line + bar (same %) + log every ~8 KB or first chunk */
	if (bytes_done_kb >= dfu_last_displayed_kb + DFU_PROGRESS_UPDATE_STEP_KB ||
	    dfu_last_displayed_kb == 0)
	{
		dfu_last_displayed_kb = bytes_done_kb;
		dfu_update_display_and_log(bytes_done_kb, bytes_done, dfu_total_bytes);
	}

	return MGMT_CB_OK;
}

static struct mgmt_callback dfu_chunk_cb_reg = {
	.callback = dfu_chunk_cb,
	.event_id = MGMT_EVT_OP_IMG_MGMT_DFU_CHUNK,
};

#endif

#if IS_ENABLED(CONFIG_MCUMGR_GRP_IMG_STATUS_HOOKS)

/* DFU 状态：started / confirmed / stopped，推屏并打 log | DFU status: started/confirmed/stopped, push display and log */
static enum mgmt_cb_return dfu_status_cb(uint32_t event, enum mgmt_cb_return prev_status,
					  int32_t *rc, uint16_t *group_id, bool *abort_more,
					  void *data, size_t data_size)
{
	ARG_UNUSED(prev_status);
	ARG_UNUSED(rc);
	ARG_UNUSED(group_id);
	ARG_UNUSED(abort_more);
	ARG_UNUSED(data);
	ARG_UNUSED(data_size);

	switch (event)
	{
	case MGMT_EVT_OP_IMG_MGMT_DFU_STARTED:
		display_update_dfu_status_text("DFU started...");
		display_update_dfu_progress(1, 0);
		LOG_INF("DFU started");
#if IS_ENABLED(CONFIG_MCUMGR_GRP_IMG_UPLOAD_CHECK_HOOK)
		dfu_last_displayed_kb = 0;
		dfu_in_progress = true;
#endif
		break;
	case MGMT_EVT_OP_IMG_MGMT_DFU_CONFIRMED:
		/* 升级结束即隐藏状态行和进度条，仅升级过程中显示 | Hide status line and bar when upgrade ends; only show during upgrade */
		display_update_dfu_status_text("");
		display_update_dfu_progress(0, 0);
		LOG_INF("DFU confirmed, reboot to apply");
#if IS_ENABLED(CONFIG_MCUMGR_GRP_IMG_UPLOAD_CHECK_HOOK)
		dfu_in_progress = false;
#endif
		break;
	case MGMT_EVT_OP_IMG_MGMT_DFU_STOPPED:
		display_update_dfu_status_text("");   /* 隐藏状态行 | Hide status line */
		display_update_dfu_progress(0, 0);
		LOG_INF("DFU stopped");
#if IS_ENABLED(CONFIG_MCUMGR_GRP_IMG_UPLOAD_CHECK_HOOK)
		dfu_in_progress = false;
#endif
		break;
	default:
		break;
	}
	return MGMT_CB_OK;
}

static struct mgmt_callback dfu_status_cb_reg = {
	.callback = dfu_status_cb,
	.event_id = MGMT_EVT_OP_IMG_MGMT_DFU_STARTED | MGMT_EVT_OP_IMG_MGMT_DFU_CONFIRMED |
		    MGMT_EVT_OP_IMG_MGMT_DFU_STOPPED,
};

#endif

void dfu_progress_init(void)
{
#if IS_ENABLED(CONFIG_MCUMGR_GRP_IMG_UPLOAD_CHECK_HOOK)
	mgmt_callback_register(&dfu_chunk_cb_reg);
	LOG_INF("DFU progress (chunk) callback registered");
#endif
#if IS_ENABLED(CONFIG_MCUMGR_GRP_IMG_STATUS_HOOKS)
	mgmt_callback_register(&dfu_status_cb_reg);
	LOG_INF("DFU progress (status) callback registered");
#endif
}
