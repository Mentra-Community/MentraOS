# MOS LVGL UI 框架说明

本组件将显示运行时、页面路由、LVGL 页面生命周期和字幕文本流水线拆分开来。Shell 里的显示测试 pattern 编号保持稳定，内部代码应优先使用命名枚举和页面 API，避免散落魔法数字。

## 构建前提

- 本组件默认并且必须启用 LVGL（不再维护 `CONFIG_LVGL` 的无 UI 分支）。

## 分层结构

- `mos_lvgl_display.c`：LVGL 线程、显示命令队列、硬件初始化和运行时协调。
- `ui_framework.c`：页面注册表、当前/上一页面状态，以及页面生命周期分发。
- `ui_lvgl_adapter.c`：将 UI 页面生命周期适配到现有 LVGL view 实现，并维护页面目录、pattern 到页面映射及 pattern/scene 兼容状态同步。
- `caption_pipeline.c`：翻译文本/protobuf 文本 pending、节流、去重、统计和提交渲染。
- `display_*_view.c`：各页面自己的 LVGL 对象创建和渲染逻辑。

说明：底层实现文件仍保留 `caption_pipeline.c` / `display_caption_view.c` 这类历史命名，
但外层运行时和新增代码优先使用 `translation_pipeline_*` / `display_translation_view_*`
这组语义别名；同理，文本长度常量优先使用 `TRANSLATION_TEXT_MAX_CHARS`。

命名约定可以简单记成三句话：

- `protobuf`：输入通道，表示文本是从 protobuf/BLE 这条链路进来的。
- `translation`：业务语义，表示当前这个页面/入口在展示翻译结果。
- `caption`：底层文本显示实现，表示节流、缓存、排版、渲染这套通用能力。

### 术语边界（这部分最重要）

这一版框架里，`protobuf`、`caption`、`translation` 不是同一层概念：

- `protobuf` 是“数据怎么进来”。
  例如手机通过 BLE 发 `DisplayText`、`DisplayScrollingText`。
- `caption` 是“通用文本显示功能”。
  它负责把一段文本稳定地显示出来，包含 pending、节流、去重、字体切换、排版和渲染。
- `translation` 是“一个具体业务页面”。
  它表示“当前这段文本是翻译结果，要按翻译页面的业务语义来展示”。

可以把它理解成下面这三层：

```text
protobuf  -> 输入通道
caption   -> 文本显示能力
translation -> 业务功能/页面
```

一句话说清楚就是：

- `protobuf` 回答“文本从哪里来”
- `caption` 回答“文本怎么显示”
- `translation` 回答“这段文本在业务上代表什么”

## 当前文本路由

当前版本里，文本类输入的默认落点已经明确区分成两条：

1. 通用 protobuf 文本：默认进入 `caption` 页
2. 显式翻译文本：进入 `translation` 页

也就是说：

```text
BLE / protobuf DisplayText
-> display_update_protobuf_text()
-> caption pipeline
-> UI_PAGE_CAPTION
```

而翻译功能是：

```text
translation 业务入口
-> display_update_translation_text()
   或 display_show_translation_screen()
-> translation 页
```

这也是为什么 `connected()` 里应该重置 `display_reset_protobuf_text_state()`：
那里重置的是“输入通道对应的待显示文本状态”，不是“翻译业务页面状态”。

### 当前版本的一个重要现实

虽然 `caption` 页和 `translation` 页在“页面身份”和“入口”上已经拆开了，
但**底层渲染实现当前还是共用一套**：

- 页面身份：已经分开
  - `UI_PAGE_CAPTION`
  - `UI_PAGE_TRANSLATION`
- 入口：已经分开
  - `display_update_protobuf_text()` 默认进 `caption`
  - `display_update_translation_text()` / `display_show_translation_screen()` 进 `translation`
- 渲染实现：当前共用
  - `caption_pipeline.c`
  - `display_caption_view.c`

所以当前阶段更准确的描述是：

```text
caption / translation 页面已经拆开
但底层文字渲染实现暂时共用
```

这意味着：

- 现在 `caption` 和 `translation` 的“页面边界”已经有了
- 但 `translation` 还没有完全做成“原文一块 + 译文一块”的专用双语布局
- 当前更多是“逻辑边界先拆开，视觉实现后续再细化”

### 当前默认规则

当前代码里，请按下面的规则理解文本显示：

- `DisplayText` / `DisplayScrollingText` 这类通用 protobuf 文本：
  默认落到 `caption` 页
- `translation` 页：
  必须显式进入
- `XY` 文本：
  走 `display_update_xy_text(...)`
- `test` 图案：
  走 `display_show_test_pattern(id)` 或 shell `display pattern <0-5>`

### 从日志怎么判断当前到底落到哪个页面

当前最可靠的判断方式不是只看 `DisplayText` 这个消息名，而是看：

- `caption_state: [STATE][CAPTION] ingest ...`
- 最终的 `[RENDER][CAPTION]` 或 `[RENDER][TRANSLATION]`
- 以及日志里打印的 `page=` 值

当前页面枚举顺序是：

```text
0 -> UI_PAGE_WELCOME
1 -> UI_PAGE_CAPTION
2 -> UI_PAGE_TRANSLATION
3 -> UI_PAGE_TEXT_XY
4 -> UI_PAGE_TEST_PATTERN
```

因此如果日志里看到：

```text
page=1
```

那就说明当前实际显示的是 `caption` 页，而不是 `translation` 页。

## Shell Pattern 协议

Shell 命令 `display pattern <0-5>` 是稳定的 bring-up 和回归测试入口：

- `0`：棋盘测试图案
- `1`：横向斑马纹测试图案
- `2`：纵向斑马纹测试图案
- `3`：滚动欢迎文本测试图案
- `4`：文本容器 / 欢迎与翻译页面
- `5`：XY 坐标文本页面

除非明确同步更新 shell 流程和测试脚本，否则不要修改这些数字含义。内部代码应使用 `display_pattern.h` 里的 `display_pattern_id_t`，不要直接写 `0/1/2/3/4/5`。

## 页面模型

页面通过 `ui_pages_register_display_pages()` 注册，该函数会把页面描述符交给 `ui_framework_register_page()`。运行时页面切换应在 LVGL 线程中通过 `ui_framework_route_to()` 触发生命周期回调。

### 当前生产路径（推荐）

- 页面切换：统一走 `ui_framework_route_to()`（避免 `navigate_to` 与 scene 混用）。
- 语言切换：更新语言状态后通过 `LCD_CMD_NOTIFY_LANGUAGE_CHANGED` 让当前页面刷新。
- 文本渲染：`caption_pipeline` 负责 ingest/throttle/dedup；当前默认把通用文本提交到 caption 页。

新增页面和后续业务入口优先走 `ui_runtime_*()` 门面，而不是直接散落调用
`ui_framework_route_to()` / `ui_pages_apply_pattern_scene()`。`ui_runtime` 负责把页面路由和
pattern/scene 兼容状态放在同一个入口里，`ui_framework` 继续作为底层页面栈和生命周期调度核心。
外部线程的按键、触摸、手势等输入应先投递 `LCD_CMD_UI_EVENT`，再由 LVGL 线程调用
`ui_framework_dispatch_event()` 分发给当前页面。

当前核心业务页面先收敛为三类：`UI_PAGE_WELCOME` 欢迎页、`UI_PAGE_CAPTION` 通用字幕页、
`UI_PAGE_TRANSLATION` 翻译页。BLE/protobuf 文本入口只做 pending text ingest，然后投递
`LCD_CMD_UPDATE_PROTOBUF_TEXT`；当前默认会把这类通用文本输入落到 caption 页。
翻译页是单独的业务页面，需要显式通过 `ui_runtime_show_translation()` /
`display_show_translation_screen()` 进入。
`protobuf` 仍然是通用输入通道，不只服务 caption 或 translation；当前只是默认把它落到 caption 页。
业务入口判断当前页面时优先使用 `ui_runtime_page_is_active()`；`display_scene` 保留为 shell
pattern、translation pipeline 和旧测试路径的兼容状态。
XY 文本页也优先通过 `ui_runtime_show_xy()` 进入，而不是在业务逻辑里直接路由到底层 page enum。
`ui_runtime_show_*()` 会同时同步默认 pattern 和与页面对应的兼容 scene mode；欢迎页、caption 页、翻译页、XY 页
不再依赖 view 层在显示过程中自行修正 scene mode。

日常记忆方式可以简单一点：

- 欢迎页：`display_show_welcome_screen()`
- caption 页：`display_update_protobuf_text(...)` 或 `display_show_caption_screen()`
- 翻译页：`display_update_translation_text(...)` 或 `display_show_translation_screen()`
- XY 页：`display_update_xy_text(...)`
- 测试图案：`display_show_test_pattern(id)` 或 `display pattern <0-5>`

`ui_framework` 当前提供三层导航能力：

- 基础页面栈：`ui_framework_push_page()` 打开新页面，`ui_framework_go_back()` 返回，`ui_framework_replace_page()` / `ui_framework_route_to()` 替换当前基础页面。
- Modal：`ui_framework_present_modal()` 在基础页面之上展示阻塞式页面，`ui_framework_dismiss_modal()` 关闭；`ui_framework_go_back()` 会优先关闭 modal。
- Overlay：`ui_framework_show_overlay()` 展示轻量浮层，`ui_framework_dismiss_overlay()` 关闭；`ui_framework_go_back()` 会优先关闭 overlay，再关闭 modal，最后返回基础页面栈。

页面参数使用 `ui_page_params_t`，由 push/replace/modal/overlay API 写入当前栈项。页面实现可通过 `ui_framework_get_current_params()` 读取参数；LVGL adapter 的 `ui_lvgl_page_context_t` 也预留了 `params` 字段，后续地图、照片、导航 payload 可以按页面类型扩展。

页面级状态可由框架托管：`ui_page_descriptor_t` 支持 `state_size/init_state/deinit_state`，并通过
`ui_framework_get_page_state()` / `ui_framework_get_current_page_state()` 读取。

当前已完成框架托管 state 的页面：

- `UI_PAGE_WELCOME`
- `UI_PAGE_CAPTION`（兼容旧名 `UI_PAGE_TEXT_CAPTION`）
- `UI_PAGE_TRANSLATION`
- `UI_PAGE_TEXT_XY`
- `UI_PAGE_TEST_PATTERN`

> 注意：`push/go_back/modal/overlay` 当前属于预留能力，默认不作为生产路径。

当前已支持页面：

- `UI_PAGE_WELCOME`
- `UI_PAGE_CAPTION`（兼容旧名 `UI_PAGE_TEXT_CAPTION`）
- `UI_PAGE_TRANSLATION`
- `UI_PAGE_TEXT_XY`
- `UI_PAGE_TEST_PATTERN`

当前预留页面：

- `UI_PAGE_IMAGE_PLACEHOLDER`
- `UI_PAGE_MAP_PLACEHOLDER`

照片和地图页面目前只是 unsupported placeholder，只预留路由名称和后续扩展点，不引入业务逻辑、图片解码、地图 payload 或导航行为。

## 运行时语言

语言状态由 `ui_framework` 维护。业务语言变化时，应先更新 framework 语言状态，再通过 `LCD_CMD_NOTIFY_LANGUAGE_CHANGED` 通知 LVGL 线程。当前页面会通过已注册的生命周期回调刷新自己。

## 后续新增页面步骤

1. 在 `ui_framework.h` 添加页面枚举。
2. 在 `ui_lvgl_adapter.c` 添加页面描述符和默认支持状态（`ui_pages_register_display_pages`）。
3. 在 `ui_lvgl_adapter.c` 或独立 adapter 文件中实现 LVGL 生命周期回调。
4. 将页面具体 LVGL 对象和渲染逻辑放到 `display_<page>_view.c`。
5. 除非刻意调整测试协议，否则保持 shell diagnostic pattern 编号不变。

推荐的新页面 state 接入模板：

1. 在 `display_<page>_view.h/.c` 定义页面 state 结构体与这三个接口：
   - `display_<page>_view_state_size()`
   - `display_<page>_view_state_init(void *state, void *context)`
   - `display_<page>_view_state_deinit(void *state, void *context)`
2. 在 `ui_pages_register_display_pages()` 对应 descriptor 填入：
   - `.state_size = ...`
   - `.init_state = ...`
   - `.deinit_state = ...`
3. 页面内部通过 state 指针持有 LVGL 对象与业务状态，避免新增文件级 static 全局变量。
