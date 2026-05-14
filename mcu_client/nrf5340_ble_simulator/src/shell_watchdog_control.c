#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <zephyr/shell/shell.h>

#include "mos_watchdog_app.h"

static void print_supported_timeouts(const struct shell *shell)
{
    shell_print(shell, "Supported timeout seconds: 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000");
}

static int cmd_wdt_help(const struct shell *shell, size_t argc, char **argv)
{
    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    shell_print(shell, "");
    shell_print(shell, "Watchdog shell commands:");
    shell_print(shell, "  wdt help             - Show this menu");
    shell_print(shell, "  wdt status           - Show watchdog status");
    shell_print(shell, "  wdt id               - Read YHM4005 ID register");
    shell_print(shell, "  wdt enable <seconds> - Enable watchdog and auto feed");
    shell_print(shell, "  wdt disable          - Disable watchdog");
    shell_print(shell, "  wdt feed             - Feed watchdog once");
    print_supported_timeouts(shell);
    shell_print(shell, "");
    return 0;
}

static int cmd_wdt_status(const struct shell *shell, size_t argc, char **argv)
{
    mos_watchdog_status_t status;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    mos_watchdog_app_get_status(&status);
    shell_print(shell, "");
    shell_print(shell, "Watchdog status:");
    shell_print(shell, "  initialized:       %s", status.initialized ? "yes" : "no");
    shell_print(shell, "  available:         %s", status.available ? "yes" : "no");
    shell_print(shell, "  enabled:           %s", status.enabled ? "yes" : "no");
    shell_print(shell, "  timeout_seconds:   %u", status.timeout_seconds);
    shell_print(shell, "  feed_interval_ms:  %u", status.feed_interval_ms);
    shell_print(shell, "  last_error:        %d", status.last_error);
    shell_print(shell, "");
    return 0;
}

static int cmd_wdt_id(const struct shell *shell, size_t argc, char **argv)
{
    int ret;
    uint8_t id = 0;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    ret = mos_watchdog_app_read_id(&id);
    if (ret != 0)
    {
        shell_error(shell, "YHM4005 ID read failed: %d", ret);
        return ret;
    }

    shell_print(shell, "YHM4005 ID: 0x%02x", id);
    return 0;
}

static int cmd_wdt_enable(const struct shell *shell, size_t argc, char **argv)
{
    int ret;
    char *end = NULL;
    unsigned long timeout_seconds;

    if (argc != 2)
    {
        shell_error(shell, "Usage: wdt enable <seconds>");
        print_supported_timeouts(shell);
        return -EINVAL;
    }

    timeout_seconds = strtoul(argv[1], &end, 10);
    if (end == argv[1] || *end != '\0' || timeout_seconds > UINT32_MAX)
    {
        shell_error(shell, "Invalid timeout: %s", argv[1]);
        print_supported_timeouts(shell);
        return -EINVAL;
    }

    ret = mos_watchdog_app_enable((uint32_t)timeout_seconds);
    if (ret != 0)
    {
        shell_error(shell, "Watchdog enable failed: %d", ret);
        print_supported_timeouts(shell);
        return ret;
    }

    shell_print(shell, "Watchdog enabled, timeout=%lus", timeout_seconds);
    return 0;
}

static int cmd_wdt_disable(const struct shell *shell, size_t argc, char **argv)
{
    int ret;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    ret = mos_watchdog_app_disable();
    if (ret != 0)
    {
        shell_error(shell, "Watchdog disable failed: %d", ret);
        return ret;
    }

    shell_print(shell, "Watchdog disabled");
    return 0;
}

static int cmd_wdt_feed(const struct shell *shell, size_t argc, char **argv)
{
    int ret;

    ARG_UNUSED(argc);
    ARG_UNUSED(argv);

    ret = mos_watchdog_app_feed();
    if (ret != 0)
    {
        shell_error(shell, "Watchdog feed failed: %d", ret);
        return ret;
    }

    shell_print(shell, "Watchdog fed");
    return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(sub_wdt,
                               SHELL_CMD(help, NULL, "Show watchdog commands help", cmd_wdt_help),
                               SHELL_CMD(status, NULL, "Show watchdog status", cmd_wdt_status),
                               SHELL_CMD(id, NULL, "Read YHM4005 ID register", cmd_wdt_id),
                               SHELL_CMD_ARG(enable, NULL, "Enable watchdog: wdt enable <seconds>", cmd_wdt_enable, 2, 0),
                               SHELL_CMD(disable, NULL, "Disable watchdog", cmd_wdt_disable),
                               SHELL_CMD(feed, NULL, "Feed watchdog once", cmd_wdt_feed),
                               SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(wdt, &sub_wdt, "Watchdog control commands", cmd_wdt_help);
