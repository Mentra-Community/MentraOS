#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>

#include "mos_driver/include/mos_iqs7211e.h"

LOG_MODULE_REGISTER(shell_iqs7211e, LOG_LEVEL_INF);

static int cmd_iqs7211e_help(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    shell_print(shell, "");
    shell_print(shell, "IQS7211E shell commands:");
    shell_print(shell, "  iqs7211e help      - Show this menu");
    shell_print(shell, "  iqs7211e chip_info - Read prod_num / ver_maj / ver_min");
    shell_print(shell, "  iqs7211e ver       - Read version words 0x00..0x09");
    shell_print(shell, "  iqs7211e touch     - Print cached runtime frame");
    shell_print(shell, "  iqs7211e rdy_on    - Re-arm RDY GPIO interrupt");
    shell_print(shell, "  iqs7211e read_reg <addr> - Read one 16-bit register");
    shell_print(shell, "");
    return 0;
}

static int iqe_get_version_words(uint16_t *words, size_t words_count)
{
    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        return ret;
    }
    return mos_iqs7211e_read_version_details(words, words_count);
}

static int cmd_iqs7211e_ver(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    uint16_t words[10] = {0};
    int ret = iqe_get_version_words(words, ARRAY_SIZE(words));
    if (ret != 0)
    {
        shell_error(shell, "iqs7211e ver failed: %d", ret);
        return ret;
    }

    shell_print(shell, "IQS7211E I2C addr (7-bit): 0x%02x", IQS7211E_I2C_ADDR);
    for (size_t i = 0U; i < ARRAY_SIZE(words); i++)
    {
        shell_print(shell, "  reg 0x%02x: 0x%04x", (unsigned)(0x00U + i), words[i]);
    }
    return 0;
}

static int cmd_iqs7211e_chip_info(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    uint16_t prod_num = 0;
    uint16_t ver_maj = 0;
    uint16_t ver_min = 0;

    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        shell_error(shell, "iqs7211e init failed: %d", ret);
        return ret;
    }

    ret = mos_iqs7211e_read_reg16(IQS7211E_REG_PRODUCT_NUMBER, &prod_num);
    if (ret != 0)
    {
        shell_error(shell, "read PRODUCT_NUMBER(0x00) failed: %d", ret);
        return ret;
    }

    ret = mos_iqs7211e_read_reg16(IQS7211E_REG_MAJOR_VERSION, &ver_maj);
    if (ret != 0)
    {
        shell_error(shell, "read MAJOR_VERSION(0x01) failed: %d", ret);
        return ret;
    }

    ret = mos_iqs7211e_read_reg16(IQS7211E_REG_MINOR_VERSION, &ver_min);
    if (ret != 0)
    {
        shell_error(shell, "read MINOR_VERSION(0x02) failed: %d", ret);
        return ret;
    }

    shell_print(shell, "IQS7211E I2C addr (7-bit): 0x%02x", IQS7211E_I2C_ADDR);
    shell_print(shell, "prod_num=0x%04x", prod_num);
    shell_print(shell, "ver_maj =0x%04x (%u)", ver_maj, (unsigned int)(ver_maj & 0x00FFu));
    shell_print(shell, "ver_min =0x%04x (%u)", ver_min, (unsigned int)(ver_min & 0x00FFu));
    return 0;
}

static int cmd_iqs7211e_touch(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        shell_error(shell, "iqs7211e init failed: %d", ret);
        return ret;
    }

    uint16_t gestures = 0;
    uint16_t info = 0;
    uint16_t f1x = 0;
    uint16_t f1y = 0;
    uint16_t relx = 0;
    uint16_t rely = 0;
    ret = mos_iqs7211e_get_last_runtime_data(&gestures, &info, &f1x, &f1y, &relx, &rely);
    if (ret != 0)
    {
        shell_error(shell, "iqs7211e get_last_runtime_data failed: %d", ret);
        if (ret == -EAGAIN)
        {
            shell_print(shell, "Tip: no RDY cache yet — interact with pad once.");
        }
        return ret;
    }

    shell_print(shell, "IQS7211E I2C addr (7-bit): 0x%02x", IQS7211E_I2C_ADDR);
    shell_print(shell, "GESTURES   (0x0E): 0x%04x", gestures);
    shell_print(shell, "INFO_FLAGS (0x0F): 0x%04x", info);
    shell_print(shell, "FINGER1_X  (0x10): 0x%04x", f1x);
    shell_print(shell, "FINGER1_Y  (0x11): 0x%04x", f1y);
    shell_print(shell, "REL_X      (0x0A): 0x%04x (%d)", relx, (int16_t)relx);
    shell_print(shell, "REL_Y      (0x0B): 0x%04x (%d)", rely, (int16_t)rely);
    return 0;
}

static int cmd_iqs7211e_rdy_on(const struct shell *shell, size_t argc, char **argv)
{
    (void)argc;
    (void)argv;

    int ret = mos_iqs7211e_init();
    if (ret != 0)
    {
        shell_error(shell, "iqs7211e init failed: %d", ret);
        return ret;
    }

    ret = mos_iqs7211e_enable_rdy_interrupt();
    if (ret != 0)
    {
        shell_error(shell, "iqs7211e rdy_on failed: %d", ret);
        shell_print(shell, "Tip: iqs7211e_rdy-gpios GPIO_ACTIVE_LOW + falling edge.");
        return ret;
    }

    shell_print(shell, "IQS7211E RDY GPIO re-armed (falling edge, active-low).");
    return 0;
}

static int cmd_iqs7211e_read_reg(const struct shell *shell, size_t argc, char **argv)
{
    if (argc != 2)
    {
        shell_error(shell, "Usage: iqs7211e read_reg <addr>");
        return -EINVAL;
    }

    char *endptr = NULL;
    unsigned long reg_ul = strtoul(argv[1], &endptr, 0);
    if ((endptr == argv[1]) || (*endptr != '\0') || (reg_ul > 0xFFUL))
    {
        shell_error(shell, "Invalid register address: %s (expected 0x00~0xFF)", argv[1]);
        return -EINVAL;
    }

    uint16_t value = 0;
    int ret = mos_iqs7211e_read_reg16((uint8_t)reg_ul, &value);
    if (ret != 0)
    {
        shell_error(shell, "read reg 0x%02lx failed: %d", reg_ul, ret);
        return ret;
    }

    shell_print(shell, "reg 0x%02lx: 0x%04x", reg_ul, value);
    return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(
    sub_iqs7211e, SHELL_CMD(help, NULL, "Show IQS7211E commands help", cmd_iqs7211e_help),
    SHELL_CMD(chip_info, NULL, "Read prod_num / ver_maj / ver_min", cmd_iqs7211e_chip_info),
    SHELL_CMD(ver, NULL, "Read version details and print all words (0x00..0x09)", cmd_iqs7211e_ver),
    SHELL_CMD(touch, NULL, "Read cached runtime (RDY)", cmd_iqs7211e_touch),
    SHELL_CMD(rdy_on, NULL, "Re-arm RDY GPIO interrupts", cmd_iqs7211e_rdy_on),
    SHELL_CMD_ARG(read_reg, NULL, "Read one 16-bit register: <addr>", cmd_iqs7211e_read_reg, 2, 0),
    SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(iqs7211e, &sub_iqs7211e, "IQS7211E touch/proximity control", cmd_iqs7211e_help);
