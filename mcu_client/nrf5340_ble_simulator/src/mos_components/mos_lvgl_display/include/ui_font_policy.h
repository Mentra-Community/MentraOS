
#ifndef UI_FONT_POLICY_H_
#define UI_FONT_POLICY_H_

#include <stdbool.h>

#include "mos_lvgl_display.h"

/* Apply runtime language preference to dynamic font engine. 
将运行时语言首选项应用于动态字体引擎*/
void ui_font_policy_apply_runtime_language(void);

/* Apply content language preference for translated/translation text. 
* 对翻译/翻译文本应用内容语言首选项*/
void ui_font_policy_apply_content_language(display_biz_lang_t src_lang, display_biz_lang_t dst_lang, bool has_cjk);

/* Whether current UI language should render Chinese copy. 
当前UI语言是否应该呈现中文副本*/
bool ui_font_policy_use_chinese_copy(void);

#endif /* UI_FONT_POLICY_H_ */
