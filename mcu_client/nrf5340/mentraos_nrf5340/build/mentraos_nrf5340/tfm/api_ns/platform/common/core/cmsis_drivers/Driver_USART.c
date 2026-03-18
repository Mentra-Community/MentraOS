/*
 * Copyright (c) 2013-2019 Arm Limited. All rights reserved.
 * Copyright (c) 2020-2021 Nordic Semiconductor ASA. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the License); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an AS IS BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include <Driver_USART.h>
#include <RTE_Device.h>
#include <nrfx_uarte.h>
#include <string.h>
#include <stdint.h>
#include <nrf-pinctrl.h>

#ifndef ARRAY_SIZE
#define ARRAY_SIZE(arr) (sizeof(arr)/sizeof(arr[0]))
#endif

#if !(DOMAIN_NS == 1U) && defined(CONFIG_TFM_LOG_SHARE_UART) && (defined(NRF_SPU) || defined(NRF_SPU00))
#define SPU_CONFIGURE_UART
#include <spu.h>
#endif

#ifndef ARG_UNUSED
#define ARG_UNUSED(arg)  (void)arg
#endif

#define ARM_USART_DRV_VERSION  ARM_DRIVER_VERSION_MAJOR_MINOR(2, 2)

#if RTE_USART0 || RTE_USART1 || RTE_USART2 || RTE_USART3 || \
    RTE_UART00 || RTE_USART20 || RTE_UART21 || RTE_UART22 || RTE_USART30

#define PSEL_DISCONNECTED 0xFFFFFFFFUL

#define UART_CONFIG_INITIALIZER()                                              \
{                                                                              \
    .txd_pin  = PSEL_DISCONNECTED,                                             \
    .rxd_pin  = PSEL_DISCONNECTED,                                             \
    .rts_pin  = PSEL_DISCONNECTED,                                             \
    .cts_pin  = PSEL_DISCONNECTED,                                             \
    .baudrate = NRF_UARTE_BAUDRATE_115200,                                     \
    .interrupt_priority = NRFX_UARTE_DEFAULT_CONFIG_IRQ_PRIORITY,              \
    .config  = {                                                               \
        .hwfc   = NRF_UARTE_HWFC_DISABLED,                                     \
        .parity = NRF_UARTE_PARITY_EXCLUDED,                                   \
        .stop   = NRF_UARTE_STOP_ONE,                                          \
    },                                                                         \
}

void uart_config_set_uart_pins(nrfx_uarte_config_t *uart_config,
                               const uint32_t uart_pins[],
                               size_t uart_pins_count)
{
    for (size_t i = 0; i < uart_pins_count; i++) {
        uint32_t psel = NRF_GET_PIN(uart_pins[i]);

        if (psel == NRF_PIN_DISCONNECTED) {
            psel = PSEL_DISCONNECTED;
        }

        switch (NRF_GET_FUN(uart_pins[i])) {
        case NRF_FUN_UART_TX:  uart_config->txd_pin = psel; break;
        case NRF_FUN_UART_RX:  uart_config->rxd_pin = psel; break;
        case NRF_FUN_UART_RTS: uart_config->rts_pin = psel; break;
        case NRF_FUN_UART_CTS: uart_config->cts_pin = psel; break;
        }
    }
}

static const ARM_DRIVER_VERSION DriverVersion = {
    ARM_USART_API_VERSION,
    ARM_USART_DRV_VERSION
};

static const ARM_USART_CAPABILITIES DriverCapabilities = {
    .asynchronous = 1,
};

typedef struct {
    const nrfx_uarte_t   uarte;
    const uint32_t      *uart_pins;
    size_t               uart_pins_count;
    size_t               tx_count;
    size_t               rx_count;
    nrf_uarte_config_t   hal_cfg;
    nrf_uarte_baudrate_t baudrate;
    bool                 initialized;
} UARTx_Resources;

static ARM_DRIVER_VERSION ARM_USART_GetVersion(void)
{
    return DriverVersion;
}

static ARM_USART_CAPABILITIES ARM_USART_GetCapabilities(void)
{
    return DriverCapabilities;
}

static int32_t ARM_USARTx_Initialize(ARM_USART_SignalEvent_t cb_event,
                                     UARTx_Resources *uart_resources)
{
    ARG_UNUSED(cb_event);

#ifdef SPU_CONFIGURE_UART
    spu_peripheral_config_secure((uint32_t)uart_resources->uarte.p_reg, false);
    NVIC_ClearTargetState(NRFX_IRQ_NUMBER_GET((uint32_t)uart_resources->uarte.p_reg));
#endif

    nrfx_uarte_config_t uart_config = UART_CONFIG_INITIALIZER();

    uart_config_set_uart_pins(&uart_config,
                              uart_resources->uart_pins,
                              uart_resources->uart_pins_count);

    nrfx_err_t err_code = nrfx_uarte_init(&uart_resources->uarte,
                                          &uart_config,
                                          NULL);
    if (err_code != NRFX_SUCCESS) {
        return ARM_DRIVER_ERROR_BUSY;
    }

    uart_resources->tx_count = 0;
    uart_resources->rx_count = 0;
    uart_resources->hal_cfg  = uart_config.config;
    uart_resources->baudrate = uart_config.baudrate;

    uart_resources->initialized = true;
    return ARM_DRIVER_OK;
}

static int32_t ARM_USARTx_Uninitialize(UARTx_Resources *uart_resources)
{
    nrfx_uarte_uninit(&uart_resources->uarte);

    uart_resources->initialized = false;

#ifdef SPU_CONFIGURE_UART
    spu_peripheral_config_non_secure((uint32_t)uart_resources->uarte.p_reg, false);
    NVIC_SetTargetState(NRFX_IRQ_NUMBER_GET((uint32_t)uart_resources->uarte.p_reg));
#endif

    return ARM_DRIVER_OK;
}

static int32_t ARM_USARTx_PowerControl(ARM_POWER_STATE state,
                                       UARTx_Resources *uart_resources)
{
    ARG_UNUSED(uart_resources);

    switch (state) {
    case ARM_POWER_FULL:
        /* Nothing to be done */
        return ARM_DRIVER_OK;

    case ARM_POWER_OFF:
    case ARM_POWER_LOW:
    default:
        return ARM_DRIVER_ERROR_UNSUPPORTED;
    }
}

#ifndef MIN
#define MIN(a,b) (((a) <= (b)) ? (a) : (b));
#endif

#define SEND_RAM_BUF_SIZE 64

static int32_t ARM_USARTx_Send(const void *data, uint32_t num,
                               UARTx_Resources *uart_resources)
{
    if (!uart_resources->initialized) {
        return ARM_DRIVER_ERROR;
    }

    /* nrfx_uarte_tx() only supports input data from RAM. */
    if (!nrfx_is_in_ram(data)) {
        uint8_t ram_buf[SEND_RAM_BUF_SIZE];

        for (uint32_t offs = 0; offs < num; offs += sizeof(ram_buf)) {
            uint32_t len = MIN(num - offs, sizeof(ram_buf));
            memcpy(ram_buf, data + offs, len);
            int32_t cmsis_err = ARM_USARTx_Send(ram_buf, len, uart_resources);
            if (cmsis_err != ARM_DRIVER_OK) {
                return cmsis_err;
            }
        }
    } else {
        nrfx_err_t err_code = nrfx_uarte_tx(&uart_resources->uarte, data, num, 0);
        if (err_code == NRFX_ERROR_BUSY) {
            return ARM_DRIVER_ERROR_BUSY;
        } else if (err_code != NRFX_SUCCESS) {
            return ARM_DRIVER_ERROR;
        }

        uart_resources->tx_count = num;
    }

    return ARM_DRIVER_OK;
}

static int32_t ARM_USARTx_Receive(void *data, uint32_t num,
                                  UARTx_Resources *uart_resources)
{
    if (!uart_resources->initialized) {
        return ARM_DRIVER_ERROR;
    }

    nrfx_err_t err_code = nrfx_uarte_rx(&uart_resources->uarte, data, num);
    if (err_code == NRFX_ERROR_BUSY) {
        return ARM_DRIVER_ERROR_BUSY;
    } else if (err_code != NRFX_SUCCESS) {
        return ARM_DRIVER_ERROR;
    }

    uart_resources->rx_count = num;
    return ARM_DRIVER_OK;
}

static int32_t ARM_USART_Transfer(const void *data_out, void *data_in,
                                  uint32_t num)
{
    ARG_UNUSED(data_out);
    ARG_UNUSED(data_in);
    ARG_UNUSED(num);

    return ARM_DRIVER_ERROR_UNSUPPORTED;
}

static uint32_t ARM_USARTx_GetTxCount(const UARTx_Resources *uart_resources)
{
    return uart_resources->tx_count;
}

static uint32_t ARM_USARTx_GetRxCount(const UARTx_Resources *uart_resources)
{
    return uart_resources->rx_count;
}

static int32_t ARM_USARTx_Control(uint32_t control, uint32_t arg,
                                  UARTx_Resources *uart_resources)
{
    if ((control & ARM_USART_CONTROL_Msk) != ARM_USART_MODE_ASYNCHRONOUS) {
        return ARM_DRIVER_ERROR_UNSUPPORTED;
    }

    nrf_uarte_baudrate_t baudrate = uart_resources->baudrate;
    nrf_uarte_config_t   hal_cfg  = uart_resources->hal_cfg;
    switch (arg) {
        case    1200: baudrate = NRF_UARTE_BAUDRATE_1200;    break;
        case    2400: baudrate = NRF_UARTE_BAUDRATE_2400;    break;
        case    4800: baudrate = NRF_UARTE_BAUDRATE_4800;    break;
        case    9600: baudrate = NRF_UARTE_BAUDRATE_9600;    break;
        case   14400: baudrate = NRF_UARTE_BAUDRATE_14400;   break;
        case   19200: baudrate = NRF_UARTE_BAUDRATE_19200;   break;
        case   28800: baudrate = NRF_UARTE_BAUDRATE_28800;   break;
        case   31250: baudrate = NRF_UARTE_BAUDRATE_31250;   break;
        case   38400: baudrate = NRF_UARTE_BAUDRATE_38400;   break;
        case   56000: baudrate = NRF_UARTE_BAUDRATE_56000;   break;
        case   57600: baudrate = NRF_UARTE_BAUDRATE_57600;   break;
        case   76800: baudrate = NRF_UARTE_BAUDRATE_76800;   break;
        case  115200: baudrate = NRF_UARTE_BAUDRATE_115200;  break;
        case  230400: baudrate = NRF_UARTE_BAUDRATE_230400;  break;
        case  250000: baudrate = NRF_UARTE_BAUDRATE_250000;  break;
        case  460800: baudrate = NRF_UARTE_BAUDRATE_460800;  break;
        case  921600: baudrate = NRF_UARTE_BAUDRATE_921600;  break;
        case 1000000: baudrate = NRF_UARTE_BAUDRATE_1000000; break;
        default:
            return ARM_USART_ERROR_BAUDRATE;
    }

    if ((control & ARM_USART_DATA_BITS_Msk) != ARM_USART_DATA_BITS_8) {
        return ARM_USART_ERROR_DATA_BITS;
    }

    switch (control & ARM_USART_STOP_BITS_Msk) {
        case ARM_USART_STOP_BITS_1:
            hal_cfg.stop = NRF_UARTE_STOP_ONE;
            break;

        case ARM_USART_STOP_BITS_2:
            hal_cfg.stop = NRF_UARTE_STOP_TWO;
            break;

        default:
            return ARM_USART_ERROR_STOP_BITS;
    }

    switch (control & ARM_USART_PARITY_Msk) {
        case ARM_USART_PARITY_NONE:
            hal_cfg.parity = NRF_UARTE_PARITY_EXCLUDED;
            break;

#if defined(UARTE_CONFIG_PARITYTYPE_Msk)
        case ARM_USART_PARITY_EVEN:
            hal_cfg.parity = NRF_UARTE_PARITY_INCLUDED;
            hal_cfg.paritytype = NRF_UARTE_PARITYTYPE_EVEN;
            break;

        case ARM_USART_PARITY_ODD:
            hal_cfg.parity = NRF_UARTE_PARITY_INCLUDED;
            hal_cfg.paritytype = NRF_UARTE_PARITYTYPE_ODD;
            break;
#else
        case ARM_USART_PARITY_EVEN:
            hal_cfg.parity = NRF_UARTE_PARITY_INCLUDED;
            break;
#endif

        default:
            return ARM_USART_ERROR_PARITY;
    }

    switch (control & ARM_USART_FLOW_CONTROL_Msk) {
        case ARM_USART_FLOW_CONTROL_NONE:
            hal_cfg.hwfc = NRF_UARTE_HWFC_DISABLED;
            break;

        case ARM_USART_FLOW_CONTROL_RTS_CTS:
            hal_cfg.hwfc = NRF_UARTE_HWFC_ENABLED;
            break;

        default:
            return ARM_USART_ERROR_FLOW_CONTROL;
    }

    uart_resources->baudrate = baudrate;
    uart_resources->hal_cfg  = hal_cfg;

    nrf_uarte_baudrate_set(uart_resources->uarte.p_reg,
                           uart_resources->baudrate);
    nrf_uarte_configure(uart_resources->uarte.p_reg,
                        &uart_resources->hal_cfg);

    return ARM_DRIVER_OK;
}

static ARM_USART_STATUS ARM_USART_GetStatus(void)
{
    ARM_USART_STATUS status = {0};
    return status;
}

static int32_t ARM_USART_SetModemControl(ARM_USART_MODEM_CONTROL control)
{
    ARG_UNUSED(control);
    return ARM_DRIVER_ERROR_UNSUPPORTED;
}

static ARM_USART_MODEM_STATUS ARM_USART_GetModemStatus(void)
{
    ARM_USART_MODEM_STATUS status = {0};
    return status;
}

#define DRIVER_USART(idx)                                                 \
    static const uint32_t UART##idx##_pins[] = RTE_USART##idx##_PINS;     \
    static UARTx_Resources UART##idx##_Resources = {                      \
        .uarte = NRFX_UARTE_INSTANCE(idx),                                \
        .uart_pins = UART##idx##_pins,                                    \
        .uart_pins_count = ARRAY_SIZE(UART##idx##_pins)                   \
    };                                                                    \
    static int32_t ARM_USART##idx##_Initialize(                           \
                                        ARM_USART_SignalEvent_t cb_event) \
    {                                                                     \
        return ARM_USARTx_Initialize(cb_event, &UART##idx##_Resources);   \
    }                                                                     \
    static int32_t ARM_USART##idx##_Uninitialize(void)                    \
    {                                                                     \
        return ARM_USARTx_Uninitialize(&UART##idx##_Resources);           \
    }                                                                     \
    static int32_t ARM_USART##idx##_PowerControl(ARM_POWER_STATE state)   \
    {                                                                     \
        return ARM_USARTx_PowerControl(state, &UART##idx##_Resources);    \
    }                                                                     \
    static int32_t ARM_USART##idx##_Send(const void *data, uint32_t num)  \
    {                                                                     \
        return ARM_USARTx_Send(data, num, &UART##idx##_Resources);        \
    }                                                                     \
    static int32_t ARM_USART##idx##_Receive(void *data, uint32_t num)     \
    {                                                                     \
        return ARM_USARTx_Receive(data, num, &UART##idx##_Resources);     \
    }                                                                     \
    static uint32_t ARM_USART##idx##_GetTxCount(void)                     \
    {                                                                     \
        return ARM_USARTx_GetTxCount(&UART##idx##_Resources);             \
    }                                                                     \
    static uint32_t ARM_USART##idx##_GetRxCount(void)                     \
    {                                                                     \
        return ARM_USARTx_GetRxCount(&UART##idx##_Resources);             \
    }                                                                     \
    static int32_t ARM_USART##idx##_Control(uint32_t control,             \
                                            uint32_t arg)                 \
    {                                                                     \
        return ARM_USARTx_Control(control, arg, &UART##idx##_Resources);  \
    }                                                                     \
    ARM_DRIVER_USART Driver_USART##idx = {                                \
        .GetVersion      = ARM_USART_GetVersion,                          \
        .GetCapabilities = ARM_USART_GetCapabilities,                     \
        .Initialize      = ARM_USART##idx##_Initialize,                   \
        .Uninitialize    = ARM_USART##idx##_Uninitialize,                 \
        .PowerControl    = ARM_USART##idx##_PowerControl,                 \
        .Send            = ARM_USART##idx##_Send,                         \
        .Receive         = ARM_USART##idx##_Receive,                      \
        .Transfer        = ARM_USART_Transfer,                            \
        .GetTxCount      = ARM_USART##idx##_GetTxCount,                   \
        .GetRxCount      = ARM_USART##idx##_GetRxCount,                   \
        .Control         = ARM_USART##idx##_Control,                      \
        .GetStatus       = ARM_USART_GetStatus,                           \
        .SetModemControl = ARM_USART_SetModemControl,                     \
        .GetModemStatus  = ARM_USART_GetModemStatus                       \
    }

#if RTE_USART0
DRIVER_USART(0);
#endif

#if RTE_USART1
DRIVER_USART(1);
#endif

#if RTE_USART2
DRIVER_USART(2);
#endif

#if RTE_USART3
DRIVER_USART(3);
#endif

#if RTE_USART00
DRIVER_USART(00);
#endif

#if RTE_USART20
DRIVER_USART(20);
#endif

#if RTE_USART21
DRIVER_USART(21);
#endif

#if RTE_USART22
DRIVER_USART(22);
#endif

#if RTE_USART30
DRIVER_USART(30);
#endif

#endif /* RTE_USART0 || RTE_USART1 || RTE_USART2 || RTE_USART3 || RTE_USART20 || RTE_USART22 */
