#include "ui_framework.h"

#include <errno.h>
#include <stddef.h>
#include <string.h>
#include <zephyr/kernel.h>

static K_MUTEX_DEFINE(s_ui_state_lock);
static ui_framework_state_t s_ui_state = {
    .current_page = UI_PAGE_WELCOME,
    .previous_page = UI_PAGE_WELCOME,
    .base_page = UI_PAGE_WELCOME,
    .active_modal = UI_PAGE_COUNT,
    .active_overlay = UI_PAGE_COUNT,
    .current_lang = UI_FRAMEWORK_DEFAULT_LANG,
    .page_stack_depth = 1U,
    .modal_depth = 0U,
    .overlay_depth = 0U,
};
static ui_page_descriptor_t s_page_registry[UI_PAGE_COUNT];
static bool s_page_registered[UI_PAGE_COUNT];
typedef union
{
    uint64_t align64;
    void *ptr_align;
    uint8_t bytes[UI_FRAMEWORK_PAGE_STATE_MAX_SIZE];
} ui_page_state_storage_t;


static ui_page_state_storage_t s_page_state_storage[UI_PAGE_COUNT];
static size_t s_page_state_size[UI_PAGE_COUNT];
static bool s_page_state_inited[UI_PAGE_COUNT];
static ui_page_stack_entry_t s_page_stack[UI_FRAMEWORK_PAGE_STACK_DEPTH];
static ui_page_stack_entry_t s_modal_stack[UI_FRAMEWORK_MODAL_STACK_DEPTH];
static ui_page_stack_entry_t s_overlay_stack[UI_FRAMEWORK_OVERLAY_STACK_DEPTH];

static bool ui_page_is_valid(ui_page_type_t page)
{
    return page >= UI_PAGE_WELCOME && page < UI_PAGE_COUNT;
}

static bool ui_page_is_default_supported(ui_page_type_t page)
{
    switch (page)
    {
        case UI_PAGE_WELCOME:
        case UI_PAGE_CAPTION:
        case UI_PAGE_TRANSLATION:
        case UI_PAGE_TEXT_XY:
        case UI_PAGE_TEST_PATTERN:
            return true;

        case UI_PAGE_IMAGE_PLACEHOLDER:
        case UI_PAGE_MAP_PLACEHOLDER:
        case UI_PAGE_COUNT:
        default:
            return false;
    }
}

static ui_page_params_t ui_page_empty_params(void)
{
    const ui_page_params_t params = {
        .value = 0U,
        .data = NULL,
        .data_size = 0U,
    };

    return params;
}

static ui_page_stack_entry_t ui_page_make_entry(ui_page_type_t page, const ui_page_params_t *params)
{
    ui_page_stack_entry_t entry = {
        .page = page,
        .params = ui_page_empty_params(),
    };

    if (params != NULL)
    {
        entry.params = *params;
    }

    return entry;
}

static bool ui_framework_copy_descriptor_locked(ui_page_type_t page, ui_page_descriptor_t *out_descriptor)
{
    if (!ui_page_is_valid(page) || !s_page_registered[page])
    {
        return false;
    }

    if (out_descriptor != NULL)
    {
        *out_descriptor = s_page_registry[page];
    }

    return true;
}

static bool ui_framework_page_is_supported_locked(ui_page_type_t page, ui_page_descriptor_t *out_descriptor)
{
    bool has_descriptor = ui_framework_copy_descriptor_locked(page, out_descriptor);

    return has_descriptor ? out_descriptor->supported : ui_page_is_default_supported(page);
}

static void *ui_framework_page_state_ptr_locked(ui_page_type_t page)
{
    if (!ui_page_is_valid(page) || s_page_state_size[page] == 0U)
    {
        return NULL;
    }

    return (void *)s_page_state_storage[page].bytes;
}

static int ui_framework_page_state_init_locked(ui_page_type_t page, const ui_page_descriptor_t *descriptor, void *context)
{
    void *state_ptr;

    if (descriptor == NULL || descriptor->state_size == 0U)
    {
        s_page_state_size[page] = 0U;
        s_page_state_inited[page] = false;
        return 0;
    }

    if (descriptor->state_size > UI_FRAMEWORK_PAGE_STATE_MAX_SIZE)
    {
        return -ENOSPC;
    }

    s_page_state_size[page] = descriptor->state_size;
    state_ptr = ui_framework_page_state_ptr_locked(page);
    if (state_ptr == NULL)
    {
        return -EINVAL;
    }
    memset(state_ptr, 0, descriptor->state_size);

    if (descriptor->init_state != NULL)
    {
        int ret = descriptor->init_state(state_ptr, context);
        if (ret != 0)
        {
            memset(state_ptr, 0, descriptor->state_size);
            s_page_state_size[page] = 0U;
            s_page_state_inited[page] = false;
            return ret;
        }
    }

    s_page_state_inited[page] = true;
    return 0;
}

static void ui_framework_page_state_deinit_locked(ui_page_type_t page, const ui_page_descriptor_t *descriptor, void *context)
{
    void *state_ptr = ui_framework_page_state_ptr_locked(page);

    if (state_ptr == NULL || !s_page_state_inited[page])
    {
        s_page_state_size[page] = 0U;
        s_page_state_inited[page] = false;
        return;
    }

    if (descriptor != NULL && descriptor->deinit_state != NULL)
    {
        (void)descriptor->deinit_state(state_ptr, context);
    }

    memset(state_ptr, 0, s_page_state_size[page]);
    s_page_state_size[page] = 0U;
    s_page_state_inited[page] = false;
}

static ui_page_type_t ui_framework_base_page_locked(void)
{
    if (s_ui_state.page_stack_depth == 0U)
    {
        return UI_PAGE_WELCOME;
    }

    return s_page_stack[s_ui_state.page_stack_depth - 1U].page;
}

static ui_page_type_t ui_framework_active_page_locked(void)
{
    if (s_ui_state.overlay_depth > 0U)
    {
        return s_overlay_stack[s_ui_state.overlay_depth - 1U].page;
    }

    if (s_ui_state.modal_depth > 0U)
    {
        return s_modal_stack[s_ui_state.modal_depth - 1U].page;
    }

    return ui_framework_base_page_locked();
}

static bool ui_framework_copy_active_params_locked(ui_page_params_t *out_params)
{
    if (out_params == NULL)
    {
        return false;
    }

    if (s_ui_state.overlay_depth > 0U)
    {
        *out_params = s_overlay_stack[s_ui_state.overlay_depth - 1U].params;
        return true;
    }

    if (s_ui_state.modal_depth > 0U)
    {
        *out_params = s_modal_stack[s_ui_state.modal_depth - 1U].params;
        return true;
    }

    if (s_ui_state.page_stack_depth > 0U)
    {
        *out_params = s_page_stack[s_ui_state.page_stack_depth - 1U].params;
        return true;
    }

    return false;
}

static void ui_framework_commit_active_locked(ui_page_type_t previous_active)
{
    s_ui_state.previous_page = previous_active;
    s_ui_state.current_page = ui_framework_active_page_locked();
    s_ui_state.base_page = ui_framework_base_page_locked();
    s_ui_state.active_modal = (s_ui_state.modal_depth > 0U) ? s_modal_stack[s_ui_state.modal_depth - 1U].page : UI_PAGE_COUNT;
    s_ui_state.active_overlay = (s_ui_state.overlay_depth > 0U) ? s_overlay_stack[s_ui_state.overlay_depth - 1U].page : UI_PAGE_COUNT;
}

static void ui_framework_reset_locked(void)
{
    s_ui_state.current_page = UI_PAGE_WELCOME;
    s_ui_state.previous_page = UI_PAGE_WELCOME;
    s_ui_state.base_page = UI_PAGE_WELCOME;
    s_ui_state.active_modal = UI_PAGE_COUNT;
    s_ui_state.active_overlay = UI_PAGE_COUNT;
    s_ui_state.current_lang = UI_FRAMEWORK_DEFAULT_LANG;
    s_ui_state.page_stack_depth = 1U;
    s_ui_state.modal_depth = 0U;
    s_ui_state.overlay_depth = 0U;

    s_page_stack[0] = ui_page_make_entry(UI_PAGE_WELCOME, NULL);

    for (ui_page_type_t page = UI_PAGE_WELCOME; page < UI_PAGE_COUNT; page++)
    {
        if (s_page_registered[page])
        {
            ui_framework_page_state_deinit_locked(page, &s_page_registry[page], NULL);
            (void)ui_framework_page_state_init_locked(page, &s_page_registry[page], NULL);
        }
    }
}

static int ui_framework_show_descriptor(const ui_page_descriptor_t *descriptor, void *context)
{
    if (descriptor == NULL || descriptor->show == NULL)
    {
        return 0;
    }

    return descriptor->show(context);
}

static int ui_framework_hide_descriptor(const ui_page_descriptor_t *descriptor, void *context, bool destroy_after_hide)
{
    int ret = 0;

    if (descriptor == NULL)
    {
        return 0;
    }

    if (descriptor->hide != NULL)
    {
        ret = descriptor->hide(context);
        if (ret != 0)
        {
            return ret;
        }
    }

    if (destroy_after_hide && descriptor->destroy != NULL)
    {
        ret = descriptor->destroy(context);
    }

    return ret;
}

static uint8_t ui_framework_copy_transient_descriptors_locked(ui_page_descriptor_t *descriptors,
                                                              uint8_t max_descriptors)
{
    uint8_t descriptor_count = 0U;

    for (uint8_t overlay_index = s_ui_state.overlay_depth; overlay_index > 0U && descriptor_count < max_descriptors;
         overlay_index--)
    {
        if (ui_framework_copy_descriptor_locked(s_overlay_stack[overlay_index - 1U].page,
                                                &descriptors[descriptor_count]))
        {
            descriptor_count++;
        }
    }

    for (uint8_t modal_index = s_ui_state.modal_depth; modal_index > 0U && descriptor_count < max_descriptors;
         modal_index--)
    {
        if (ui_framework_copy_descriptor_locked(s_modal_stack[modal_index - 1U].page, &descriptors[descriptor_count]))
        {
            descriptor_count++;
        }
    }

    return descriptor_count;
}

static int ui_framework_hide_descriptor_list(ui_page_descriptor_t *descriptors, uint8_t descriptor_count, void *context)
{
    for (uint8_t descriptor_index = 0U; descriptor_index < descriptor_count; descriptor_index++)
    {
        int ret = ui_framework_hide_descriptor(&descriptors[descriptor_index], context, true);
        if (ret != 0)
        {
            return ret;
        }
    }

    return 0;
}

void ui_framework_init(void)
{
    ui_framework_reset();
}

void ui_framework_reset(void)
{
    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    ui_framework_reset_locked();
    k_mutex_unlock(&s_ui_state_lock);
}

void ui_framework_navigate_to(ui_page_type_t page)
{
    ui_page_type_t previous_active;

    if (!ui_page_is_valid(page))
    {
        return;
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    previous_active = ui_framework_active_page_locked();
    if (s_ui_state.page_stack_depth == 0U)
    {
        s_ui_state.page_stack_depth = 1U;
    }
    s_page_stack[s_ui_state.page_stack_depth - 1U] = ui_page_make_entry(page, NULL);
    ui_framework_commit_active_locked(previous_active);
    k_mutex_unlock(&s_ui_state_lock);
}

int ui_framework_register_page(const ui_page_descriptor_t *descriptor)
{
    ui_page_descriptor_t old_descriptor;
    bool had_old_descriptor;
    int init_ret = 0;

    if (descriptor == NULL || !ui_page_is_valid(descriptor->page))
    {
        return -EINVAL;
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    had_old_descriptor = s_page_registered[descriptor->page];
    if (had_old_descriptor)
    {
        old_descriptor = s_page_registry[descriptor->page];
        ui_framework_page_state_deinit_locked(descriptor->page, &old_descriptor, NULL);
    }
    s_page_registry[descriptor->page] = *descriptor;
    s_page_registered[descriptor->page] = true;
    init_ret = ui_framework_page_state_init_locked(descriptor->page, descriptor, NULL);
    if (init_ret != 0)
    {
        s_page_registered[descriptor->page] = false;
    }
    k_mutex_unlock(&s_ui_state_lock);

    return init_ret;
}

const ui_page_descriptor_t *ui_framework_get_page_descriptor(ui_page_type_t page)
{
    const ui_page_descriptor_t *descriptor = NULL;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    if (ui_framework_copy_descriptor_locked(page, NULL))
    {
        descriptor = &s_page_registry[page];
    }
    k_mutex_unlock(&s_ui_state_lock);

    return descriptor;
}

void *ui_framework_get_page_state(ui_page_type_t page)
{
    void *state_ptr = NULL;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    state_ptr = ui_framework_page_state_ptr_locked(page);
    k_mutex_unlock(&s_ui_state_lock);

    return state_ptr;
}

void *ui_framework_get_current_page_state(void)
{
    void *state_ptr = NULL;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    state_ptr = ui_framework_page_state_ptr_locked(ui_framework_active_page_locked());
    k_mutex_unlock(&s_ui_state_lock);

    return state_ptr;
}
/*
 * Replace the current base page with a new page.
 *
 * This is the main production navigation path: it drops transient modal/overlay
 * layers, hides the old base page, then shows the new one.
 * 替换当前基础页面。
 * 这是当前生产路径的主要页面切换方式：先清空临时 modal/overlay，再隐藏旧基础页，最后显示新页面。
 */
int ui_framework_replace_page(ui_page_type_t page, const ui_page_params_t *params, void *context)
{
    ui_page_descriptor_t transient_descriptors[UI_FRAMEWORK_MODAL_STACK_DEPTH + UI_FRAMEWORK_OVERLAY_STACK_DEPTH];
    ui_page_descriptor_t old_descriptor;
    ui_page_descriptor_t new_descriptor;
    ui_page_type_t previous_active;
    ui_page_type_t old_page;
    uint8_t transient_count = 0U;
    bool has_old_descriptor;
    bool has_new_descriptor;
    int ret;

    if (!ui_page_is_valid(page))
    {
        return -EINVAL;
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    has_new_descriptor = ui_framework_copy_descriptor_locked(page, &new_descriptor);
    if (!ui_framework_page_is_supported_locked(page, &new_descriptor))
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENOTSUP;
    }

    previous_active = ui_framework_active_page_locked();
    old_page = ui_framework_base_page_locked();
    has_old_descriptor = ui_framework_copy_descriptor_locked(old_page, &old_descriptor);
    transient_count = ui_framework_copy_transient_descriptors_locked(
        transient_descriptors, (uint8_t)(UI_FRAMEWORK_MODAL_STACK_DEPTH + UI_FRAMEWORK_OVERLAY_STACK_DEPTH));

    if (s_ui_state.page_stack_depth == 0U)
    {
        s_ui_state.page_stack_depth = 1U;
    }
    s_page_stack[s_ui_state.page_stack_depth - 1U] = ui_page_make_entry(page, params);
    s_ui_state.modal_depth = 0U;
    s_ui_state.overlay_depth = 0U;
    ui_framework_commit_active_locked(previous_active);
    k_mutex_unlock(&s_ui_state_lock);

    ret = ui_framework_hide_descriptor_list(transient_descriptors, transient_count, context);
    if (ret != 0)
    {
        return ret;
    }

    if (old_page != page && has_old_descriptor)
    {
        ret = ui_framework_hide_descriptor(&old_descriptor, context, false);
        if (ret != 0)
        {
            return ret;
        }
    }

    return has_new_descriptor ? ui_framework_show_descriptor(&new_descriptor, context) : 0;
}
int ui_framework_route_to_with_params(ui_page_type_t page, const ui_page_params_t *params, void *context)
{
    return ui_framework_replace_page(page, params, context);
}
int ui_framework_route_to(ui_page_type_t page, void *context)
{
    return ui_framework_route_to_with_params(page, NULL, context);
}

int ui_framework_push_page(ui_page_type_t page, const ui_page_params_t *params, void *context)
{
    ui_page_descriptor_t transient_descriptors[UI_FRAMEWORK_MODAL_STACK_DEPTH + UI_FRAMEWORK_OVERLAY_STACK_DEPTH];
    ui_page_descriptor_t old_descriptor;
    ui_page_descriptor_t new_descriptor;
    ui_page_type_t previous_active;
    ui_page_type_t old_page;
    uint8_t transient_count = 0U;
    bool has_old_descriptor;
    bool has_new_descriptor;
    int ret;

    if (!ui_page_is_valid(page))
    {
        return -EINVAL;
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    if (s_ui_state.page_stack_depth >= UI_FRAMEWORK_PAGE_STACK_DEPTH)
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENOSPC;
    }

    has_new_descriptor = ui_framework_copy_descriptor_locked(page, &new_descriptor);
    if (!ui_framework_page_is_supported_locked(page, &new_descriptor))
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENOTSUP;
    }

    previous_active = ui_framework_active_page_locked();
    old_page = ui_framework_base_page_locked();
    has_old_descriptor = ui_framework_copy_descriptor_locked(old_page, &old_descriptor);
    transient_count = ui_framework_copy_transient_descriptors_locked(
        transient_descriptors, (uint8_t)(UI_FRAMEWORK_MODAL_STACK_DEPTH + UI_FRAMEWORK_OVERLAY_STACK_DEPTH));

    s_page_stack[s_ui_state.page_stack_depth] = ui_page_make_entry(page, params);
    s_ui_state.page_stack_depth++;
    s_ui_state.modal_depth = 0U;
    s_ui_state.overlay_depth = 0U;
    ui_framework_commit_active_locked(previous_active);
    k_mutex_unlock(&s_ui_state_lock);

    ret = ui_framework_hide_descriptor_list(transient_descriptors, transient_count, context);
    if (ret != 0)
    {
        return ret;
    }

    if (has_old_descriptor)
    {
        ret = ui_framework_hide_descriptor(&old_descriptor, context, false);
        if (ret != 0)
        {
            return ret;
        }
    }

    return has_new_descriptor ? ui_framework_show_descriptor(&new_descriptor, context) : 0;
}

int ui_framework_go_back(void *context)
{
    ui_page_descriptor_t old_descriptor;
    ui_page_descriptor_t new_descriptor;
    ui_page_type_t previous_active;
    bool has_old_descriptor;
    bool has_new_descriptor;
    int ret;

    if (ui_framework_has_overlay())
    {
        return ui_framework_dismiss_overlay(context);
    }

    if (ui_framework_has_modal())
    {
        return ui_framework_dismiss_modal(context);
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    if (s_ui_state.page_stack_depth <= 1U)
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENODATA;
    }

    previous_active = ui_framework_active_page_locked();
    has_old_descriptor = ui_framework_copy_descriptor_locked(s_page_stack[s_ui_state.page_stack_depth - 1U].page, &old_descriptor);
    has_new_descriptor = ui_framework_copy_descriptor_locked(s_page_stack[s_ui_state.page_stack_depth - 2U].page, &new_descriptor);
    s_ui_state.page_stack_depth--;
    ui_framework_commit_active_locked(previous_active);
    k_mutex_unlock(&s_ui_state_lock);

    if (has_old_descriptor)
    {
        ret = ui_framework_hide_descriptor(&old_descriptor, context, true);
        if (ret != 0)
        {
            return ret;
        }
    }

    return has_new_descriptor ? ui_framework_show_descriptor(&new_descriptor, context) : 0;
}

bool ui_framework_can_go_back(void)
{
    bool can_go_back;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    can_go_back = (s_ui_state.overlay_depth > 0U) || (s_ui_state.modal_depth > 0U) || (s_ui_state.page_stack_depth > 1U);
    k_mutex_unlock(&s_ui_state_lock);

    return can_go_back;
}

int ui_framework_present_modal(ui_page_type_t page, const ui_page_params_t *params, void *context)
{
    ui_page_descriptor_t descriptor;
    ui_page_type_t previous_active;
    bool has_descriptor;

    if (!ui_page_is_valid(page))
    {
        return -EINVAL;
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    if (s_ui_state.modal_depth >= UI_FRAMEWORK_MODAL_STACK_DEPTH)
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENOSPC;
    }

    has_descriptor = ui_framework_copy_descriptor_locked(page, &descriptor);
    if (!ui_framework_page_is_supported_locked(page, &descriptor))
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENOTSUP;
    }

    previous_active = ui_framework_active_page_locked();
    s_modal_stack[s_ui_state.modal_depth] = ui_page_make_entry(page, params);
    s_ui_state.modal_depth++;
    ui_framework_commit_active_locked(previous_active);
    k_mutex_unlock(&s_ui_state_lock);

    return has_descriptor ? ui_framework_show_descriptor(&descriptor, context) : 0;
}

int ui_framework_dismiss_modal(void *context)
{
    ui_page_descriptor_t descriptor;
    ui_page_type_t previous_active;
    bool has_descriptor;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    if (s_ui_state.overlay_depth > 0U)
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -EBUSY;
    }

    if (s_ui_state.modal_depth == 0U)
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENODATA;
    }

    previous_active = ui_framework_active_page_locked();
    has_descriptor = ui_framework_copy_descriptor_locked(s_modal_stack[s_ui_state.modal_depth - 1U].page, &descriptor);
    s_ui_state.modal_depth--;
    ui_framework_commit_active_locked(previous_active);
    k_mutex_unlock(&s_ui_state_lock);

    return has_descriptor ? ui_framework_hide_descriptor(&descriptor, context, true) : 0;
}

bool ui_framework_has_modal(void)
{
    bool has_modal;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    has_modal = s_ui_state.modal_depth > 0U;
    k_mutex_unlock(&s_ui_state_lock);

    return has_modal;
}

int ui_framework_show_overlay(ui_page_type_t page, const ui_page_params_t *params, void *context)
{
    ui_page_descriptor_t descriptor;
    ui_page_type_t previous_active;
    bool has_descriptor;

    if (!ui_page_is_valid(page))
    {
        return -EINVAL;
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    if (s_ui_state.overlay_depth >= UI_FRAMEWORK_OVERLAY_STACK_DEPTH)
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENOSPC;
    }

    has_descriptor = ui_framework_copy_descriptor_locked(page, &descriptor);
    if (!ui_framework_page_is_supported_locked(page, &descriptor))
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENOTSUP;
    }

    previous_active = ui_framework_active_page_locked();
    s_overlay_stack[s_ui_state.overlay_depth] = ui_page_make_entry(page, params);
    s_ui_state.overlay_depth++;
    ui_framework_commit_active_locked(previous_active);
    k_mutex_unlock(&s_ui_state_lock);

    return has_descriptor ? ui_framework_show_descriptor(&descriptor, context) : 0;
}

int ui_framework_dismiss_overlay(void *context)
{
    ui_page_descriptor_t descriptor;
    ui_page_type_t previous_active;
    bool has_descriptor;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    if (s_ui_state.overlay_depth == 0U)
    {
        k_mutex_unlock(&s_ui_state_lock);
        return -ENODATA;
    }

    previous_active = ui_framework_active_page_locked();
    has_descriptor = ui_framework_copy_descriptor_locked(s_overlay_stack[s_ui_state.overlay_depth - 1U].page, &descriptor);
    s_ui_state.overlay_depth--;
    ui_framework_commit_active_locked(previous_active);
    k_mutex_unlock(&s_ui_state_lock);

    return has_descriptor ? ui_framework_hide_descriptor(&descriptor, context, true) : 0;
}

bool ui_framework_has_overlay(void)
{
    bool has_overlay;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    has_overlay = s_ui_state.overlay_depth > 0U;
    k_mutex_unlock(&s_ui_state_lock);

    return has_overlay;
}

int ui_framework_refresh_current(void *context)
{
    ui_page_descriptor_t descriptor;
    ui_page_type_t page;
    bool has_descriptor;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    page = ui_framework_active_page_locked();
    has_descriptor = ui_framework_copy_descriptor_locked(page, &descriptor);
    k_mutex_unlock(&s_ui_state_lock);

    if (!has_descriptor || descriptor.refresh == NULL)
    {
        return 0;
    }

    return descriptor.refresh(context);
}

int ui_framework_notify_language_changed(void *context)
{
    ui_page_descriptor_t descriptor;
    ui_page_type_t page;
    ui_lang_t lang;
    bool has_descriptor;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    page = ui_framework_active_page_locked();
    lang = s_ui_state.current_lang;
    has_descriptor = ui_framework_copy_descriptor_locked(page, &descriptor);
    k_mutex_unlock(&s_ui_state_lock);

    if (!has_descriptor || descriptor.on_language_changed == NULL)
    {
        return ui_framework_refresh_current(context);
    }

    return descriptor.on_language_changed(lang, context);
}

int ui_framework_dispatch_event(const ui_event_t *event, void *context)
{
    ui_page_descriptor_t descriptor;
    ui_page_type_t page;
    bool has_descriptor;

    if (event == NULL || event->type == UI_EVENT_NONE)
    {
        return -EINVAL;
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    page = ui_framework_active_page_locked();
    has_descriptor = ui_framework_copy_descriptor_locked(page, &descriptor);
    k_mutex_unlock(&s_ui_state_lock);

    if (has_descriptor && descriptor.on_event != NULL)
    {
        int ret = descriptor.on_event(event, context);
        if (ret != -ENOSYS)
        {
            return ret;
        }
    }

    if (event->type == UI_EVENT_BACK)
    {
        return ui_framework_go_back(context);
    }

    return -ENOSYS;
}

ui_page_type_t ui_framework_get_current_page(void)
{
    ui_page_type_t page;
    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    page = s_ui_state.current_page;
    k_mutex_unlock(&s_ui_state_lock);
    return page;
}

ui_page_type_t ui_framework_get_previous_page(void)
{
    ui_page_type_t page;
    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    page = s_ui_state.previous_page;
    k_mutex_unlock(&s_ui_state_lock);
    return page;
}

ui_page_type_t ui_framework_get_base_page(void)
{
    ui_page_type_t page;
    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    page = s_ui_state.base_page;
    k_mutex_unlock(&s_ui_state_lock);
    return page;
}

ui_page_type_t ui_framework_get_active_page(void)
{
    return ui_framework_get_current_page();
}

uint8_t ui_framework_get_stack_depth(void)
{
    uint8_t stack_depth;
    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    stack_depth = s_ui_state.page_stack_depth;
    k_mutex_unlock(&s_ui_state_lock);
    return stack_depth;
}

uint8_t ui_framework_get_modal_depth(void)
{
    uint8_t modal_depth;
    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    modal_depth = s_ui_state.modal_depth;
    k_mutex_unlock(&s_ui_state_lock);
    return modal_depth;
}

uint8_t ui_framework_get_overlay_depth(void)
{
    uint8_t overlay_depth;
    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    overlay_depth = s_ui_state.overlay_depth;
    k_mutex_unlock(&s_ui_state_lock);
    return overlay_depth;
}

bool ui_framework_get_current_params(ui_page_params_t *out_params)
{
    bool has_params;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    has_params = ui_framework_copy_active_params_locked(out_params);
    k_mutex_unlock(&s_ui_state_lock);

    return has_params;
}

void ui_framework_set_language(ui_lang_t lang)
{
    if (lang == UI_LANG_UNKNOWN)
    {
        return;
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    s_ui_state.current_lang = lang;
    k_mutex_unlock(&s_ui_state_lock);
}

ui_lang_t ui_framework_get_language(void)
{
    ui_lang_t lang;
    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    lang = s_ui_state.current_lang;
    k_mutex_unlock(&s_ui_state_lock);
    return lang;
}

void ui_framework_get_state(ui_framework_state_t *out_state)
{
    if (out_state == NULL)
    {
        return;
    }

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    *out_state = s_ui_state;
    k_mutex_unlock(&s_ui_state_lock);
}

bool ui_framework_page_is_supported(ui_page_type_t page)
{
    bool supported;

    k_mutex_lock(&s_ui_state_lock, K_FOREVER);
    if (ui_page_is_valid(page) && s_page_registered[page])
    {
        supported = s_page_registry[page].supported;
    }
    else
    {
        supported = ui_page_is_default_supported(page);
    }
    k_mutex_unlock(&s_ui_state_lock);

    return supported;
}
