#include "text_diag.h"

#if defined(CONFIG_MOS_DISPLAY_TEXT_PAYLOAD_DIAG)

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(text_diag, LOG_LEVEL_DBG);

#define TEXT_PAYLOAD_ESC_CAP 192U

void mos_text_diag_log_payload(const char *text)
{
    if (text == NULL)
    {
        LOG_INF("[TEXT_PAYLOAD] (null)");
        return;
    }

    size_t len = strlen(text);
    size_t n_lf = 0U;
    size_t n_cr = 0U;
    int first_lf = -1;
    int first_cr = -1;
    const uint8_t *bytes = (const uint8_t *)text;

    for (size_t i = 0U; i < len; ++i)
    {
        if (bytes[i] == (uint8_t)'\n')
        {
            if (first_lf < 0) first_lf = (int)i;
            n_lf++;
        }
        if (bytes[i] == (uint8_t)'\r')
        {
            if (first_cr < 0) first_cr = (int)i;
            n_cr++;
        }
    }

    char esc[TEXT_PAYLOAD_ESC_CAP];
    size_t oi = 0U;
    const uint8_t *p = bytes;
    for (; *p != '\0' && oi + 6U < TEXT_PAYLOAD_ESC_CAP; ++p)
    {
        if (*p == (uint8_t)'\n')
        {
            esc[oi++] = '\\';
            esc[oi++] = 'n';
        }
        else if (*p == (uint8_t)'\r')
        {
            esc[oi++] = '\\';
            esc[oi++] = 'r';
        }
        else if (*p == (uint8_t)'\t')
        {
            esc[oi++] = '\\';
            esc[oi++] = 't';
        }
        else if (*p < 0x20u || *p == 0x7Fu)
        {
            int w = snprintf(esc + oi, TEXT_PAYLOAD_ESC_CAP - oi, "\\x%02x", (unsigned int)*p);
            if (w <= 0 || (size_t)w >= TEXT_PAYLOAD_ESC_CAP - oi)
            {
                break;
            }
            oi += (size_t)w;
        }
        else
        {
            esc[oi++] = (char)*p;
        }
    }
    esc[oi] = '\0';

    const char *trunc = (*p != '\0') ? "...(esc_trunc)" : "";

    LOG_INF("[TEXT_PAYLOAD] len=%zu LF=%zu CR=%zu first_LF_off=%d first_CR_off=%d esc=\"%s\"%s",
            len, n_lf, n_cr, first_lf, first_cr, esc, trunc);
}

#else  /* !CONFIG_MOS_DISPLAY_TEXT_PAYLOAD_DIAG */

void mos_text_diag_log_payload(const char *text)
{
    (void)text;
}

#endif
