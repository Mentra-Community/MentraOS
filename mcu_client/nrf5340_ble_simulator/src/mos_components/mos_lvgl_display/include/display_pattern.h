#ifndef DISPLAY_PATTERN_H_
#define DISPLAY_PATTERN_H_

#include <stdbool.h>

/*
 * Shell-visible diagnostic pattern IDs.
 *
 * Keep these numeric values stable: display shell commands use 0..5 for
 * bring-up and regression testing. Internal UI routing should use the names
 * below instead of raw numbers.
 */
typedef enum
{
    DISPLAY_PATTERN_CHESS = 0,
    DISPLAY_PATTERN_HORIZONTAL_ZEBRA = 1,
    DISPLAY_PATTERN_VERTICAL_ZEBRA = 2,
    DISPLAY_PATTERN_SCROLLING_WELCOME = 3,
    DISPLAY_PATTERN_TEXT_CONTAINER = 4,
    DISPLAY_PATTERN_XY_TEXT = 5,
    DISPLAY_PATTERN_COUNT,
} display_pattern_id_t;

#define DISPLAY_PATTERN_FIRST DISPLAY_PATTERN_CHESS
#define DISPLAY_PATTERN_LAST DISPLAY_PATTERN_XY_TEXT
#define DISPLAY_PATTERN_DEFAULT DISPLAY_PATTERN_TEXT_CONTAINER

static inline bool display_pattern_id_is_valid(int pattern_id)
{
    return pattern_id >= DISPLAY_PATTERN_FIRST && pattern_id < DISPLAY_PATTERN_COUNT;
}

static inline const char *display_pattern_name(display_pattern_id_t pattern_id)
{
    switch (pattern_id)
    {
        case DISPLAY_PATTERN_CHESS:
            return "chess";
        case DISPLAY_PATTERN_HORIZONTAL_ZEBRA:
            return "horizontal_zebra";
        case DISPLAY_PATTERN_VERTICAL_ZEBRA:
            return "vertical_zebra";
        case DISPLAY_PATTERN_SCROLLING_WELCOME:
            return "scrolling_welcome";
        case DISPLAY_PATTERN_TEXT_CONTAINER:
            return "text_container";
        case DISPLAY_PATTERN_XY_TEXT:
            return "xy_text";
        case DISPLAY_PATTERN_COUNT:
        default:
            return "unknown";
    }
}

#endif /* DISPLAY_PATTERN_H_ */
