/*
 * Shell Audio Control Module
 * 
 * Audio/PDM microphone test commands (independent of BLE)
 * 
 * Commands:
 * - audio help        : Show help
 * - audio start       : Start complete audio system (PDM + LC3 + I2S loopback)
 * - audio stop        : Stop complete audio system
 * - audio status      : Show current audio/PDM status
 * 
 * Purpose: Test PDM microphone and audio pipeline without BLE connection
 * When I2S is enabled, audio will be played back via I2S for verification
 */

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/logging/log.h>
#include <errno.h>
#include <string.h>

#include "pdm_audio_stream.h"

LOG_MODULE_REGISTER(shell_audio, LOG_LEVEL_INF);

static bool i2s_manual_session = false;

static const char *state_to_str(pdm_audio_state_t state)
{
	switch (state)
	{
	case PDM_AUDIO_STATE_ENABLED:
		return "Enabled";
	case PDM_AUDIO_STATE_STREAMING:
		return "Streaming";
	case PDM_AUDIO_STATE_DISABLED:
		return "Disabled";
	case PDM_AUDIO_STATE_ERROR:
		return "Error";
	default:
		return "Unknown";
	}
}

static const char *channel_to_str(pdm_channel_t channel)
{
	switch (channel)
	{
	case PDM_CHANNEL_LEFT:
		return "left";
	case PDM_CHANNEL_RIGHT:
		return "right";
	case PDM_CHANNEL_STEREO_MIXED:
		return "mix";
	default:
		return "unknown";
	}
}

static int cmd_audio_help(const struct shell *shell, size_t argc, char **argv)
{
	(void)argc;
	(void)argv;

	shell_print(shell, "");
	shell_print(shell, "Audio Test Commands:");
	shell_print(shell, "  audio start               - Start PDM + I2S loopback test");
	shell_print(shell, "  audio stop                - Stop test and release hardware");
	shell_print(shell, "  audio status              - Show status and stats");
	shell_print(shell, "  audio mic <left|right|mix> - Select PDM input channel or stereo mix");
	shell_print(shell, "  audio i2s <on|off>        - Enable or disable I2S loopback output");
	shell_print(shell, "  audio help                - Show this help");
	shell_print(shell, "");
	shell_print(shell, "Test Flow:");
	shell_print(shell, "  1. audio start            - Auto init I2S + start loopback");
	shell_print(shell, "  2. Speak to microphone    - Hear PDM data via I2S");
	shell_print(shell, "  3. audio status           - Check frame stats");
	shell_print(shell, "  4. audio stop             - Stop + uninit I2S");
	shell_print(shell, "");
	shell_print(shell, "Pipeline:");
	shell_print(shell, "  Mic -> PDM -> LC3 Encode -> BLE (normal)");
	shell_print(shell, "           -> LC3 Decode -> I2S -> Speaker (shell test only)");
	shell_print(shell, "");
	shell_print(shell, "Note: I2S is for shell test only, not used in normal BLE mode");
	shell_print(shell, "");
	return 0;
}

static int cmd_audio_start(const struct shell *shell, size_t argc, char **argv)
{
	(void)argc;
	(void)argv;

	extern bool audio_i2s_is_initialized(void);
	extern void audio_i2s_init(void);
	extern void audio_i2s_start(void);
	extern void audio_i2s_uninit(void);

	if (audio_i2s_is_initialized())
	{
		shell_print(shell, "");
		shell_warn(shell, "Audio test system is already running");
		shell_print(shell, "Use 'audio stop' first to stop current test");
		shell_print(shell, "");
		return 0;
	}

	shell_print(shell, "");
	shell_print(shell, "Starting audio system for shell test...");

	int ret = pdm_audio_stream_set_enabled(true);
	if (ret == -EALREADY)
	{
		shell_warn(shell, "PDM audio conversion already started");
		shell_print(shell, "Use 'audio stop' first");
		shell_print(shell, "");
		return 0;
	}
	else if (ret < 0)
	{
		shell_error(shell, "Failed to start PDM audio: %d", ret);
		return ret;
	}
	shell_print(shell, "  PDM audio conversion started");

	if (!audio_i2s_is_initialized())
	{
		shell_print(shell, "  Initializing I2S hardware...");
		audio_i2s_init();
		shell_print(shell, "  I2S hardware initialized");
	}

	shell_print(shell, "  Starting I2S playback...");
	audio_i2s_start();
	int i2s_ret = pdm_audio_set_i2s_output(true);
	if (i2s_ret < 0)
	{
		shell_error(shell, "  Failed to enable I2S loopback: %d", i2s_ret);
		audio_i2s_uninit();
		return i2s_ret;
	}
	shell_print(shell, "  I2S loopback started");

	shell_print(shell, "");
	shell_print(shell, "Audio test system ready");
	shell_print(shell, "  PDM capture: Active");
	shell_print(shell, "  LC3 encode/decode: Active");
	shell_print(shell, "  I2S loopback: Active");
	shell_print(shell, "Speak to microphone to hear loopback via I2S");
	shell_print(shell, "");
	return 0;
}

static int cmd_audio_stop(const struct shell *shell, size_t argc, char **argv)
{
	(void)argc;
	(void)argv;

	extern bool audio_i2s_is_initialized(void);
	extern void audio_i2s_uninit(void);

	bool i2s_initialized = audio_i2s_is_initialized();

	if (!i2s_initialized)
	{
		shell_print(shell, "");
		shell_warn(shell, "Audio test system is already stopped");
		shell_print(shell, "Use 'audio start' to begin testing");
		shell_print(shell, "");
		return 0;
	}

	shell_print(shell, "");
	shell_print(shell, "Stopping audio test system...");
	shell_print(shell, "  Stopping PDM audio (fade-out + tail drop)...");
	shell_print(shell, "  Waiting for audio thread to complete stop sequence...");
	int ret = pdm_audio_stream_set_enabled(false);
	if (ret == 0)
	{
		k_msleep(100);
		shell_print(shell, "  PDM audio stopped");
	}
	else if (ret < 0 && ret != -EALREADY)
	{
		shell_error(shell, "  Failed to stop PDM audio: %d", ret);
		return ret;
	}

	if (i2s_initialized)
	{
		shell_print(shell, "  Uninitializing I2S hardware...");
		audio_i2s_uninit();
		shell_print(shell, "  I2S hardware released");
	}

	shell_print(shell, "");
	shell_print(shell, "Audio test system stopped");
	shell_print(shell, "");
	return 0;
}

static int cmd_audio_status(const struct shell *shell, size_t argc, char **argv)
{
	(void)argc;
	(void)argv;

	extern bool audio_i2s_is_initialized(void);

	pdm_audio_state_t state = pdm_audio_stream_get_state();
	bool i2s_output = pdm_audio_get_i2s_output();
	bool i2s_initialized = audio_i2s_is_initialized();
	pdm_channel_t channel = pdm_audio_stream_get_channel();

	uint32_t frames_captured = 0;
	uint32_t frames_encoded = 0;
	uint32_t frames_transmitted = 0;
	uint32_t errors = 0;
	pdm_audio_stream_get_stats(&frames_captured, &frames_encoded, &frames_transmitted, &errors);

	shell_print(shell, "");
	shell_print(shell, "Audio System Status:");
	shell_print(shell, "  State           : %s", state_to_str(state));
	shell_print(shell, "  Mic Channel     : %s", channel_to_str(channel));
	shell_print(shell, "  I2S Loopback    : %s", i2s_output ? "Enabled" : "Disabled");
	shell_print(shell, "  I2S Hardware    : %s", i2s_initialized ? "Initialized" : "Not initialized");
	shell_print(shell, "");
	shell_print(shell, "Statistics:");
	shell_print(shell, "  Frames Captured : %u", (unsigned)frames_captured);
	shell_print(shell, "  Frames Encoded  : %u", (unsigned)frames_encoded);
	shell_print(shell, "  Frames Sent     : %u", (unsigned)frames_transmitted);
	shell_print(shell, "  Errors          : %u", (unsigned)errors);
	shell_print(shell, "");
	return 0;
}

static int cmd_audio_mic(const struct shell *shell, size_t argc, char **argv)
{
	if (argc != 2)
	{
		shell_error(shell, "Usage: audio mic <left|right|mix>");
		return -EINVAL;
	}

	pdm_channel_t channel;
	if (strcmp(argv[1], "left") == 0)
	{
		channel = PDM_CHANNEL_LEFT;
	}
	else if (strcmp(argv[1], "right") == 0)
	{
		channel = PDM_CHANNEL_RIGHT;
	}
	else if (strcmp(argv[1], "mix") == 0)
	{
		channel = PDM_CHANNEL_STEREO_MIXED;
	}
	else
	{
		shell_error(shell, "Invalid option '%s'. Use left, right, or mix.", argv[1]);
		return -EINVAL;
	}

	int ret = pdm_audio_stream_set_channel(channel);
	if (ret < 0)
	{
		shell_error(shell, "Failed to set mic channel: %d", ret);
		return ret;
	}

	shell_print(shell, "Mic channel set to %s", channel_to_str(channel));
	return 0;
}

static int cmd_audio_i2s(const struct shell *shell, size_t argc, char **argv)
{
	if (argc != 2)
	{
		shell_error(shell, "Usage: audio i2s <on|off>");
		return -EINVAL;
	}

	bool enable;
	if (strcmp(argv[1], "on") == 0)
	{
		enable = true;
	}
	else if (strcmp(argv[1], "off") == 0)
	{
		enable = false;
	}
	else
	{
		shell_error(shell, "Invalid option '%s'. Use on or off.", argv[1]);
		return -EINVAL;
	}

	extern bool audio_i2s_is_initialized(void);
	extern bool audio_i2s_is_started(void);
	extern void audio_i2s_init(void);
	extern void audio_i2s_start(void);
	extern void audio_i2s_stop(void);
	extern void audio_i2s_uninit(void);

	if (enable)
	{
		bool was_initialized = audio_i2s_is_initialized();
		if (!was_initialized)
		{
			audio_i2s_init();
			if (!audio_i2s_is_initialized())
			{
				shell_error(shell, "Failed to initialize I2S hardware");
				return -EIO;
			}
			i2s_manual_session = true;
		}
		if (!audio_i2s_is_started())
		{
			audio_i2s_start();
		}

		int rc = pdm_audio_set_i2s_output(true);
		if (rc < 0)
		{
			if (i2s_manual_session)
			{
				if (audio_i2s_is_started())
				{
					audio_i2s_stop();
				}
				audio_i2s_uninit();
				i2s_manual_session = false;
			}
			shell_error(shell, "Failed to enable I2S loopback: %d", rc);
			return rc;
		}
	}
	else
	{
		int rc = pdm_audio_set_i2s_output(false);
		if (rc < 0)
		{
			shell_error(shell, "Failed to disable I2S loopback: %d", rc);
			return rc;
		}

		if (i2s_manual_session)
		{
			if (audio_i2s_is_initialized())
			{
				if (audio_i2s_is_started())
				{
					audio_i2s_stop();
				}
				audio_i2s_uninit();
			}
			i2s_manual_session = false;
		}
	}

	shell_print(shell, "I2S loopback %s", enable ? "enabled" : "disabled");
	return 0;
}

/* Audio control commands / 音频控制命令 */
SHELL_STATIC_SUBCMD_SET_CREATE(sub_audio,
	SHELL_CMD(help,   NULL, "Show audio help",    cmd_audio_help),
	SHELL_CMD(start,  NULL, "Start audio test",   cmd_audio_start),
	SHELL_CMD(stop,   NULL, "Stop audio test",    cmd_audio_stop),
	SHELL_CMD(status, NULL, "Show audio status",  cmd_audio_status),
	SHELL_CMD(mic,    NULL, "Select mic channel", cmd_audio_mic),
	SHELL_CMD(i2s,    NULL, "Toggle I2S loopback", cmd_audio_i2s),
	SHELL_SUBCMD_SET_END
);

SHELL_CMD_REGISTER(audio, &sub_audio, "Audio test commands (PDM + I2S loopback)", cmd_audio_help);

