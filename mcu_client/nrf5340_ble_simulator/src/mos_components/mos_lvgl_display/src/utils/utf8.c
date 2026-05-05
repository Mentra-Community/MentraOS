#include "utils/utf8.h"

bool utf8_is_ascii_only(const char *text)
{
    if (!text)
    {
        return true;
    }
    for (const uint8_t *p = (const uint8_t *)text; *p != '\0'; ++p)
    {
        if (*p >= 0x80u)
        {
            return false;
        }
    }
    return true;
}

bool utf8_first_non_ascii_codepoint(const char *text, uint32_t *out_codepoint)
{
    if (!text || !out_codepoint)
    {
        return false;
    }

    const uint8_t *p = (const uint8_t *)text;
    while (*p != '\0')
    {
        uint32_t code = 0;
        uint8_t len = 1;

        if ((*p & 0x80u) == 0)
        {
            p += 1;
            continue;
        }
        else if ((*p & 0xE0u) == 0xC0u)
        {
            if ((p[1] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            len = 2;
        }
        else if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (uint32_t)(p[2] & 0x3Fu);
            len = 3;
        }
        else if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) | ((uint32_t)(p[2] & 0x3Fu) << 6)
                   | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }
        else
        {
            return false;
        }

        *out_codepoint = code;
        return true;
    }

    return false;
}

bool utf8_contains_cjk(const char *text)
{
    if (!text)
    {
        return false;
    }

    const uint8_t *p = (const uint8_t *)text;
    while (*p != '\0')
    {
        uint32_t code = 0;
        uint8_t len = 1;

        if ((*p & 0x80u) == 0)
        {
            code = *p;
            len = 1;
        }
        else if ((*p & 0xE0u) == 0xC0u)
        {
            if ((p[1] & 0xC0u) != 0x80u)
            {
                break;
            }
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            len = 2;
        }
        else if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
            {
                break;
            }
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (uint32_t)(p[2] & 0x3Fu);
            len = 3;
        }
        else if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
            {
                break;
            }
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) | ((uint32_t)(p[2] & 0x3Fu) << 6)
                   | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }

        /* 兼容常见 CJK 字符块 + 常用中日韩标点/全角字符 + 韩文 Hangul */
        if ((code >= 0x3400u && code <= 0x9FFFu) || (code >= 0xF900u && code <= 0xFAFFu)
            || (code >= 0x20000u && code <= 0x2EBEFu) || (code >= 0x3000u && code <= 0x303Fu)
            || (code >= 0xFF00u && code <= 0xFFEFu) || (code >= 0x1100u && code <= 0x11FFu)
            || (code >= 0x3130u && code <= 0x318Fu) || (code >= 0xAC00u && code <= 0xD7AFu))
        {
            return true;
        }

        p += len;
    }

    return false;
}

bool utf8_first_cjk_codepoint(const char *text, uint32_t *out_codepoint)
{
    if (!text || !out_codepoint)
    {
        return false;
    }

    const uint8_t *p = (const uint8_t *)text;
    while (*p != '\0')
    {
        uint32_t code = 0;
        uint8_t len = 1;

        if ((*p & 0x80u) == 0)
        {
            code = *p;
            len = 1;
        }
        else if ((*p & 0xE0u) == 0xC0u)
        {
            if ((p[1] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x1Fu) << 6) | (uint32_t)(p[1] & 0x3Fu);
            len = 2;
        }
        else if ((*p & 0xF0u) == 0xE0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x0Fu) << 12) | ((uint32_t)(p[1] & 0x3Fu) << 6) | (uint32_t)(p[2] & 0x3Fu);
            len = 3;
        }
        else if ((*p & 0xF8u) == 0xF0u)
        {
            if ((p[1] & 0xC0u) != 0x80u || (p[2] & 0xC0u) != 0x80u || (p[3] & 0xC0u) != 0x80u)
            {
                return false;
            }
            code = ((uint32_t)(p[0] & 0x07u) << 18) | ((uint32_t)(p[1] & 0x3Fu) << 12) | ((uint32_t)(p[2] & 0x3Fu) << 6)
                   | (uint32_t)(p[3] & 0x3Fu);
            len = 4;
        }

        if ((code >= 0x3400u && code <= 0x9FFFu) || (code >= 0xF900u && code <= 0xFAFFu)
            || (code >= 0x20000u && code <= 0x2EBEFu) || (code >= 0x3000u && code <= 0x303Fu)
            || (code >= 0xFF00u && code <= 0xFFEFu) || (code >= 0x1100u && code <= 0x11FFu)
            || (code >= 0x3130u && code <= 0x318Fu) || (code >= 0xAC00u && code <= 0xD7AFu))
        {
            *out_codepoint = code;
            return true;
        }

        p += len;
    }

    return false;
}

bool is_cjk_codepoint(uint32_t code)
{
    /* 兼容常见 CJK 字符块 + 常用中日韩标点/全角字符 + 韩文 Hangul */
    return ((code >= 0x3400u && code <= 0x9FFFu) || (code >= 0xF900u && code <= 0xFAFFu)
            || (code >= 0x20000u && code <= 0x2EBEFu) || (code >= 0x3000u && code <= 0x303Fu)
            || (code >= 0xFF00u && code <= 0xFFEFu) || (code >= 0x1100u && code <= 0x11FFu)
            || (code >= 0x3130u && code <= 0x318Fu) || (code >= 0xAC00u && code <= 0xD7AFu));
}
