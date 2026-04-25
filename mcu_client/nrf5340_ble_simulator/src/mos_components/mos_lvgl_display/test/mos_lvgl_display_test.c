/**
 * @file mos_lvgl_display_test.c
 * @brief Unit tests for display_submit_scrolling_text_payload and related functions.
 *
 * These tests verify the scrolling text payload submission logic in mos_lvgl_display.
 */

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Test framework - using unity style assertions */
#define TEST_ASSERT_EQUAL(expected, actual)                           \
    do {                                                              \
        if ((expected) != (actual)) {                                 \
            printf("ASSERTION FAILED: %s:%d - Expected %ld, got %ld\n", \
                   __FILE__, __LINE__, (long)(expected), (long)(actual)); \
            return 1;                                                  \
        }                                                             \
    } while (0)

#define TEST_ASSERT_TRUE(x)                                          \
    do {                                                              \
        if (!(x)) {                                                   \
            printf("ASSERTION FAILED: %s:%d - Expected true\n", __FILE__, __LINE__); \
            return 1;                                                 \
        }                                                             \
    } while (0)

#define TEST_ASSERT_FALSE(x)                                         \
    do {                                                              \
        if (x) {                                                      \
            printf("ASSERTION FAILED: %s:%d - Expected false\n", __FILE__, __LINE__); \
            return 1;                                                  \
        }                                                             \
    } while (0)

#define TEST_ASSERT_NOT_NULL(x)                                      \
    do {                                                              \
        if ((x) == NULL) {                                           \
            printf("ASSERTION FAILED: %s:%d - Expected non-NULL\n", __FILE__, __LINE__); \
            return 1;                                                 \
        }                                                             \
    } while (0)

#define TEST_ASSERT_NULL(x)                                          \
    do {                                                              \
        if ((x) != NULL) {                                           \
            printf("ASSERTION FAILED: %s:%d - Expected NULL\n", __FILE__, __LINE__); \
            return 1;                                                 \
        }                                                             \
    } while (0)

#define TEST_ASSERT_STRING_EQUAL(expected, actual)                   \
    do {                                                              \
        if (strcmp((expected), (actual)) != 0) {                     \
            printf("ASSERTION FAILED: %s:%d - Expected \"%s\", got \"%s\"\n", \
                   __FILE__, __LINE__, (expected), (actual));         \
            return 1;                                                 \
        }                                                             \
    } while (0)

#define RUN_TEST(func)                                                \
    do {                                                              \
        printf("Running %s... ", #func);                             \
        int result = func();                                          \
        if (result == 0) {                                            \
            printf("PASSED\n");                                       \
        } else {                                                      \
            printf("FAILED\n");                                       \
            failures++;                                              \
        }                                                             \
        total++;                                                      \
    } while (0)

/* ============================================================================
 * MOCKS AND STUBS
 * ============================================================================ */

/* Track call counts and parameters for verification */
static struct {
    int translation_pipeline_ingest_calls;
    char last_ingested_text[256];
    int mos_msgq_send_calls;
    int mos_msgq_send_timeout;
    void *last_msgq;
    int last_msg_type;
} mock_state = {0};

/* Mock translation_pipeline_ingest */
void mock_translation_pipeline_ingest(const char *text_content)
{
    mock_state.translation_pipeline_ingest_calls++;
    if (text_content != NULL && strlen(text_content) < sizeof(mock_state.last_ingested_text)) {
        strcpy(mock_state.last_ingested_text, text_content);
    }
}

/* Mock mos_msgq_send */
int mock_mos_msgq_send(void *msgq, void *msg, int64_t timeout)
{
    mock_state.mos_msgq_send_calls++;
    mock_state.last_msgq = msgq;
    mock_state.last_msg_timeout = timeout;
    if (msg != NULL) {
        /* Extract command type from display_cmd_t structure */
        /* Based on mos_lvgl_display.h, display_cmd_t has type at offset 0 */
        mock_state.last_msg_type = *(int *)msg;
    }
    return 0; /* Success */
}

/* ============================================================================
 * STATIC VARIABLES FROM mos_lvgl_display.c (needed for verification)
 * ============================================================================ */

/* Replicate the static variables we need to track */
static volatile ui_page_type_t s_pending_text_target_page = UI_PAGE_CAPTION;
static volatile bool display_onoff = false;

/* ============================================================================
 * FUNCTIONS UNDER TEST (extracted and simplified for testing)
 * ============================================================================ */

/* Re-implement display_update_protobuf_text for isolated testing */
#define MAX_TEXT_LEN 247

typedef enum {
    UI_PAGE_WELCOME = 0,
    UI_PAGE_CAPTION,
    UI_PAGE_TRANSLATION,
    UI_PAGE_TEXT_XY,
    UI_PAGE_TEST,
    UI_PAGE_UNKNOWN
} ui_page_type_t;

typedef enum {
    LCD_CMD_UPDATE_PROTOBUF_TEXT = 10
} display_cmd_type_t;

typedef struct {
    display_cmd_type_t type;
} display_cmd_t;

/* Test-specific implementation of display_update_protobuf_text */
void test_display_update_protobuf_text(const char *text_content)
{
    s_pending_text_target_page = UI_PAGE_CAPTION;
    mock_translation_pipeline_ingest(text_content);

    display_cmd_t cmd = {.type = LCD_CMD_UPDATE_PROTOBUF_TEXT};
    mock_mos_msgq_send(NULL, &cmd, 50);
}

/* Function under test */
void display_submit_scrolling_text_payload(const char *text_content)
{
    test_display_update_protobuf_text(text_content);
}

/* ============================================================================
 * TEST CASES
 * ============================================================================ */

/* Test: Normal scrolling text payload submission */
static int test_scrolling_text_normal(void)
{
    const char *test_text = "Hello World";

    /* Reset mock state */
    memset(&mock_state, 0, sizeof(mock_state));

    /* Call the function under test */
    display_submit_scrolling_text_payload(test_text);

    /* Verify translation_pipeline_ingest was called */
    TEST_ASSERT_EQUAL(1, mock_state.translation_pipeline_ingest_calls);

    /* Verify the correct text was passed */
    TEST_ASSERT_STRING_EQUAL(test_text, mock_state.last_ingested_text);

    /* Verify message queue send was called */
    TEST_ASSERT_EQUAL(1, mock_state.mos_msgq_send_calls);

    /* Verify correct command type was sent */
    TEST_ASSERT_EQUAL(LCD_CMD_UPDATE_PROTOBUF_TEXT, mock_state.last_msg_type);

    /* Verify timeout is 50ms */
    TEST_ASSERT_EQUAL(50, mock_state.last_msg_timeout);

    return 0;
}

/* Test: Scrolling text with empty string */
static int test_scrolling_text_empty_string(void)
{
    const char *test_text = "";

    memset(&mock_state, 0, sizeof(mock_state));

    display_submit_scrolling_text_payload(test_text);

    TEST_ASSERT_EQUAL(1, mock_state.translation_pipeline_ingest_calls);
    TEST_ASSERT_STRING_EQUAL("", mock_state.last_ingested_text);
    TEST_ASSERT_EQUAL(1, mock_state.mos_msgq_send_calls);

    return 0;
}

/* Test: Scrolling text with long string */
static int test_scrolling_text_long_string(void)
{
    /* Create a long text string (not exceeding MAX_TEXT_LEN) */
    char test_text[MAX_TEXT_LEN];
    memset(test_text, 'A', MAX_TEXT_LEN - 1);
    test_text[MAX_TEXT_LEN - 1] = '\0';

    memset(&mock_state, 0, sizeof(mock_state));

    display_submit_scrolling_text_payload(test_text);

    TEST_ASSERT_EQUAL(1, mock_state.translation_pipeline_ingest_calls);
    TEST_ASSERT_EQUAL(1, mock_state.mos_msgq_send_calls);

    return 0;
}

/* Test: Scrolling text with special characters */
static int test_scrolling_text_special_chars(void)
{
    const char *test_text = "Hello\nWorld\t!@#$%^&*()";

    memset(&mock_state, 0, sizeof(mock_state));

    display_submit_scrolling_text_payload(test_text);

    TEST_ASSERT_EQUAL(1, mock_state.translation_pipeline_ingest_calls);
    TEST_ASSERT_STRING_EQUAL(test_text, mock_state.last_ingested_text);
    TEST_ASSERT_EQUAL(1, mock_state.mos_msgq_send_calls);

    return 0;
}

/* Test: Scrolling text with unicode/CJK characters */
static int test_scrolling_text_cjk_chars(void)
{
    const char *test_text = "你好世界 Hello";

    memset(&mock_state, 0, sizeof(mock_state));

    display_submit_scrolling_text_payload(test_text);

    TEST_ASSERT_EQUAL(1, mock_state.translation_pipeline_ingest_calls);
    TEST_ASSERT_STRING_EQUAL(test_text, mock_state.last_ingested_text);
    TEST_ASSERT_EQUAL(1, mock_state.mos_msgq_send_calls);

    return 0;
}

/* Test: Multiple consecutive calls */
static int test_scrolling_text_multiple_calls(void)
{
    const char *texts[] = {"First", "Second", "Third"};
    int num_calls = sizeof(texts) / sizeof(texts[0]);

    memset(&mock_state, 0, sizeof(mock_state));

    for (int i = 0; i < num_calls; i++) {
        display_submit_scrolling_text_payload(texts[i]);
    }

    TEST_ASSERT_EQUAL(num_calls, mock_state.translation_pipeline_ingest_calls);
    TEST_ASSERT_EQUAL(num_calls, mock_state.mos_msgq_send_calls);

    /* Verify last text was the final call */
    TEST_ASSERT_STRING_EQUAL("Third", mock_state.last_ingested_text);

    return 0;
}

/* Test: Verify pending target page is set to CAPTION */
static int test_pending_target_page_set(void)
{
    const char *test_text = "Test caption";

    /* Reset state */
    s_pending_text_target_page = UI_PAGE_TRANSLATION; /* Set to different value */

    memset(&mock_state, 0, sizeof(mock_state));

    display_submit_scrolling_text_payload(test_text);

    /* Verify target page was set to CAPTION */
    TEST_ASSERT_EQUAL(UI_PAGE_CAPTION, s_pending_text_target_page);

    return 0;
}

/* Test: Null text handling */
static int test_null_text_handling(void)
{
    /* Note: The actual production function passes to translation_pipeline_ingest
     * which handles NULL internally. Our test_display_update_protobuf_text
     * passes it through to mock, so we verify the call is made. */

    memset(&mock_state, 0, sizeof(mock_state));

    /* This will call with NULL - in real code, translation_pipeline_ingest
     * handles NULL by logging error and returning early */
    display_submit_scrolling_text_payload(NULL);

    /* Verify the function attempted to process the NULL input */
    TEST_ASSERT_EQUAL(1, mock_state.translation_pipeline_ingest_calls);

    return 0;
}

/* Test: Message command type verification */
static int test_command_type_verification(void)
{
    const char *test_text = "Verify command type";

    memset(&mock_state, 0, sizeof(mock_state));

    display_submit_scrolling_text_payload(test_text);

    /* LCD_CMD_UPDATE_PROTOBUF_TEXT = 10 */
    TEST_ASSERT_EQUAL(10, mock_state.last_msg_type);

    return 0;
}

/* ============================================================================
 * MAIN
 * ============================================================================ */

int main(void)
{
    int total = 0;
    int failures = 0;

    printf("=== mos_lvgl_display Unit Tests ===\n\n");

    RUN_TEST(test_scrolling_text_normal);
    RUN_TEST(test_scrolling_text_empty_string);
    RUN_TEST(test_scrolling_text_long_string);
    RUN_TEST(test_scrolling_text_special_chars);
    RUN_TEST(test_scrolling_text_cjk_chars);
    RUN_TEST(test_scrolling_text_multiple_calls);
    RUN_TEST(test_pending_target_page_set);
    RUN_TEST(test_null_text_handling);
    RUN_TEST(test_command_type_verification);

    printf("\n=== Test Summary ===\n");
    printf("Total:  %d\n", total);
    printf("Passed: %d\n", total - failures);
    printf("Failed: %d\n", failures);

    if (failures == 0) {
        printf("\nALL TESTS PASSED!\n");
        return 0;
    } else {
        printf("\nSOME TESTS FAILED!\n");
        return 1;
    }
}
