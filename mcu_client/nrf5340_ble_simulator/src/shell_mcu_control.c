#include <stddef.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/reboot.h>

static int cmd_mcu_help(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    shell_print(shell, "");
    shell_print(shell, "MCU shell commands:");
    shell_print(shell, "  mcu help   - Show this menu");
    shell_print(shell, "  mcu reboot - Reboot MCU with SYS_REBOOT_COLD");
    shell_print(shell, "");
    return 0;
}

static int cmd_mcu_reboot(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    shell_print(shell, "Rebooting MCU with SYS_REBOOT_COLD...");
    sys_reboot(SYS_REBOOT_COLD);
    return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(sub_mcu,
                               SHELL_CMD(help, NULL, "Show MCU commands help", cmd_mcu_help),
                               SHELL_CMD(reboot, NULL, "Reboot MCU with SYS_REBOOT_COLD", cmd_mcu_reboot),
                               SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(mcu, &sub_mcu, "MCU control commands", cmd_mcu_help);
