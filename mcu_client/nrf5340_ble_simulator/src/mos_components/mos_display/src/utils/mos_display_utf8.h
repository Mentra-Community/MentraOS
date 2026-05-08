#ifndef MOS_DISPLAY_UTF8_H_
#define MOS_DISPLAY_UTF8_H_

#include <stdbool.h>
#include <stdint.h>

/**
 * Returns true if all bytes in text are ASCII (< 0x80).
 */
bool utf8_is_ascii_only(const char *text);

/**
 * Finds the first non-ASCII (>= 0x80) codepoint in text.
 * Returns true and writes the codepoint to *out_codepoint if found.
 */
bool utf8_first_non_ascii_codepoint(const char *text, uint32_t *out_codepoint);

/**
 * Returns true if text contains any CJK codepoint.
 */
bool utf8_contains_cjk(const char *text);

/**
 * Finds the first CJK codepoint in text.
 * Returns true and writes the codepoint to *out_codepoint if found.
 */
bool utf8_first_cjk_codepoint(const char *text, uint32_t *out_codepoint);

/**
 * Returns true if code falls in a CJK Unicode block.
 */
bool is_cjk_codepoint(uint32_t code);

#endif /* MOS_DISPLAY_UTF8_H_ */
