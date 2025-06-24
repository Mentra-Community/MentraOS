# Layouts

MentraOS Cloud provides a set of pre-defined layouts for displaying content on the smart glasses' AR view. These layouts allow you to create visually consistent and user-friendly interfaces without needing to deal with low-level graphics programming. You interact with layouts through the [`LayoutManager`](/reference/managers/layout-manager), which is a property of the [`TpaSession`](/reference/tpa-session) object.

```typescript
// Example of accessing the LayoutManager
session.layouts.showTextWall("Hello, World!");
```

## Available Layout Types

The SDK currently supports the following layout types:

### 1. `TextWall`

*   **Purpose:** Displays a single block of text.  This is the most basic layout and is suitable for simple messages, status updates, and short notifications.
*   **Type:** [`LayoutType.TEXT_WALL`](/reference/enums#layouttype)
*   **Properties:**
    *   `text`: The text content to display (string).

*   **Example:**

    ```typescript
    import { TpaSession, LayoutType, ViewType, TpaToCloudMessageType } from '@mentra/sdk';

    // Assuming you have a TpaSession instance called 'session'
    session.layouts.showTextWall("Connected to MentraOS Cloud");

    // Example of a complete DisplayRequest for a TextWall.
    // You don't normally construct this directly; the LayoutManager does it.
    const displayRequest: DisplayRequest = {
      type: TpaToCloudMessageType.DISPLAY_REQUEST,
      view: ViewType.MAIN,
      packageName: "com.example.myapp",
      sessionId: "some-session-id",
      layout: {
        layoutType: LayoutType.TEXT_WALL,
        text: "Hello, TextWall!"
      },
      timestamp: new Date(),
      durationMs: 5000  // Optional duration
    };
    ```

### 2. `DoubleTextWall`

*   **Purpose:** Displays two blocks of text, one above the other. This is useful for showing two related pieces of information, such as a title and a subtitle, or a before/after comparison.
*   **Type:** [`LayoutType.DOUBLE_TEXT_WALL`](/reference/enums#layouttype)
*   **Properties:**
    *   `topText`: The text for the top section.
    *   `bottomText`: The text for the bottom section.

*   **Example:**

    ```typescript
    session.layouts.showDoubleTextWall(
      "Original Text:",
      "Translated Text:"
    );
    ```

### 3. `ReferenceCard`

*   **Purpose:**  Displays a card with a title and content text.  This is a more structured layout, suitable for displaying important information, notifications with titles, or key data points.
*   **Type:** [`LayoutType.REFERENCE_CARD`](/reference/enums#layouttype)
*   **Properties:**
    *   `title`:  The title of the card (string).
    *   `text`:  The main content of the card (string).

*   **Example:**

    ```typescript
    session.layouts.showReferenceCard(
      "Meeting Reminder",
      "Team Standup in 5 minutes"
    );
    ```

### 4. `DashboardCard`

*   **Purpose:**  Displays a card with left-aligned and right-aligned text.  This layout is ideal for key-value pairs, metrics, and dashboard-style displays.
*   **Type:** [`LayoutType.DASHBOARD_CARD`](/reference/enums#layouttype)
*   **Properties:**
    *   `leftText`: Text for the left side (often a label or key).
    *   `rightText`: Text for the right side (often a value or status).

*   **Example:**

    ```typescript
    session.layouts.showDashboardCard(
      "Battery Level",
      "85%"
    );
    ```

### 5. `BitmapView`

* **Purpose:** Displays a bitmap image on the glasses. The image data should be a base64 encoded string.
* **Type:** [`LayoutType.BITMAP_VIEW`](/reference/enums#layouttype)
* **Properties:**
  * `data`: A base64 encoded string representing the bitmap data.

* **Example:**
  ```typescript
  session.layouts.showBitmapView(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...", {durationMs: 5000}
  );
  ```

## Display Duration (`durationMs`)

All layout methods accept an optional `options` object, which can include a `durationMs` property. This property controls how long the layout is displayed on the glasses, in milliseconds.

*   **`durationMs: number` (optional):**  The duration, in milliseconds, to display the layout.
*   **`durationMs: -1`:** Indicates that the layout should be displayed persistently, until it is explicitly replaced or cleared.  This is useful for content that should remain visible until further notice.
*   **Omitting `durationMs`:**  If you omit `durationMs`, the behavior depends on whether you are sending interim transcription.
    If it's provided, the layout will remain until replaced or cleared.  If the duration is omitted the current `DisplayManager` implementation will display for 20 seconds.  This behavior should not be relied upon.  Always provide `durationMs` in production code.

```typescript
// Display for 5 seconds
session.layouts.showTextWall("This will disappear in 5 seconds", { durationMs: 5000 });

// Display persistently (until replaced or cleared)
session.layouts.showReferenceCard("Important", "This will stay on screen", {durationMs: -1});
```

## View Type

The `options` object in the layout methods also allows you to specify a `view` property:

```typescript
interface LayoutOptions {
  view?: ViewType;
  durationMs?: number;
}
```

*   **[`ViewType.MAIN`](/reference/enums#viewtype) (default):** The main AR view that the user sees most of the time.
*   **[`ViewType.DASHBOARD`](/reference/enums#viewtype):**  A special dashboard view.  Currently, the user looks up to access the dashboard.

```typescript
// Display in the main view (default)
session.layouts.showTextWall("Hello in main view");

// Display in the dashboard view
session.layouts.showTextWall("Dashboard Message", { view: ViewType.DASHBOARD });
```

## Layout Interfaces

The `@mentra/sdk` provides TypeScript interfaces for each layout type.  These interfaces ensure type safety and provide autocompletion in your IDE.  You can import these directly:

```typescript
import { TextWall, DoubleTextWall, ReferenceCard, LayoutType, ViewType } from '@mentra/sdk';

const textWallLayout: TextWall = {
  layoutType: LayoutType.TEXT_WALL,
  text: "Hello, TextWall!"
};
```

## Best Practices

*   **Keep it Concise:** The glasses display has limited space. Use short, clear text.  Avoid long paragraphs or complex layouts.
*   **Prioritize Information:**  Display the most important information prominently.
*   **Use Appropriate Layouts:**  Choose the layout type that best suits the content you're displaying.
*   **Consider Head Position:** The [`head_position`](/reference/interfaces/event-types#headposition) event lets you know if the user is looking up (at the dashboard) or down (at the main view).  You can use this to tailor the displayed content.
*   **Avoid Flicker:** Rapidly changing the display can be visually jarring.  Use appropriate durations and consider debouncing or throttling updates if necessary.
* **Text Wrapping:** The glasses have limited width, so it is important to handle text that is longer than can fit on one line. The `@mentraos/utils` package provides a `wrapText` utility function to handle this.
