---
sidebar_position: 3
title: Layout Types
---

# Layout Types

This page documents the layout interfaces used to display content in the AR view.

## Layout Interface

The `Layout` type is a union of all available layout types:

```typescript
type Layout = TextWall | DoubleTextWall | DashboardCard | ReferenceCard | BitmapView;
```

Each layout has a specific structure that defines how content is presented in the AR display.

## TextWall

A simple layout for displaying a single block of text.

```typescript
interface TextWall {
  /** Must be LayoutType.TEXT_WALL. */
  layoutType: LayoutType.TEXT_WALL;
  
  /** The text content to display. */
  text: string;
}
```

**Example:**
```typescript
// You typically won't create this directly, but would use the LayoutManager method
const textWall: TextWall = {
  layoutType: LayoutType.TEXT_WALL,
  text: "This is a simple text wall with a single message."
};

// Using the LayoutManager
tpaSession.layouts.showTextWall("This is a simple text wall with a single message.");
```

## DoubleTextWall

A layout for displaying two blocks of text vertically.

```typescript
interface DoubleTextWall {
  /** Must be LayoutType.DOUBLE_TEXT_WALL. */
  layoutType: LayoutType.DOUBLE_TEXT_WALL;
  
  /** Text for the upper section. */
  topText: string;
  
  /** Text for the lower section. */
  bottomText: string;
}
```

**Example:**
```typescript
// Using the LayoutManager
tpaSession.layouts.showDoubleTextWall(
  "This is the top section",
  "This is the bottom section"
);
```

## ReferenceCard

A card-style layout with a title and main content text.

```typescript
interface ReferenceCard {
  /** Must be LayoutType.REFERENCE_CARD. */
  layoutType: LayoutType.REFERENCE_CARD;
  
  /** The title text for the card. */
  title: string;
  
  /** The main body text for the card. */
  text: string;
}
```

**Example:**
```typescript
// Using the LayoutManager
tpaSession.layouts.showReferenceCard(
  "Recipe: Chocolate Chip Cookies",
  "Ingredients:\n- 2 cups flour\n- 1 cup sugar\n- 1/2 cup butter\n..."
);
```

## DashboardCard

A card-style layout designed for displaying key-value pairs, typically used in dashboards.

```typescript
interface DashboardCard {
  /** Must be LayoutType.DASHBOARD_CARD. */
  layoutType: LayoutType.DASHBOARD_CARD;
  
  /** Text for the left side (usually a label). */
  leftText: string;
  
  /** Text for the right side (usually a value). */
  rightText: string;
}
```

**Example:**
```typescript
// Using the LayoutManager
tpaSession.layouts.showDashboardCard("Temperature", "72°F");
```

## BitmapView

A layout for displaying bitmap images.

```typescript
interface BitmapView {
  /** Must be LayoutType.BITMAP_VIEW. */
  layoutType: LayoutType.BITMAP_VIEW;
  
  /** Base64 encoded string of the bitmap data. */
  data: string;
}
```

**Example:**
```typescript
// Using the LayoutManager with a base64-encoded image
const base64Image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...";
tpaSession.layouts.showBitmapView(base64Image);
```

## DisplayRequest

The `DisplayRequest` interface is the message structure sent to AugmentOS Cloud when a TPA wants to display a layout.

```typescript
interface DisplayRequest extends BaseMessage {
  /** Must be TpaToCloudMessageType.DISPLAY_REQUEST. */
  type: TpaToCloudMessageType.DISPLAY_REQUEST;
  
  /** The package name of the TPA making the request. */
  packageName: string;
  
  /** The target display area (MAIN or DASHBOARD). */
  view: ViewType;
  
  /** The specific layout configuration object to display. */
  layout: Layout;
  
  /** Optional time (in ms) to display the layout before automatically clearing it. */
  durationMs?: number;
  
  /** Optional flag to attempt to force display even if another app is active (use with caution). */
  forceDisplay?: boolean;
}
```

**Note:** You typically don't need to create `DisplayRequest` objects directly, as the [`LayoutManager`](/reference/managers/layout-manager) methods handle this for you.

## Best Practices for Layouts

### TextWall
- Best for simple messages that need to be displayed briefly
- Keep text concise and focused on a single idea
- Good for notifications, status updates, or simple responses

### DoubleTextWall
- Use when you need to separate a header/title from content
- The top section works well for brief category or context
- The bottom section provides the main information
- Example: "Current Weather" (top) and "72°F, Partly Cloudy" (bottom)

### ReferenceCard
- Best for information that users may need to reference for a longer period
- Clear title helps set context for the content
- Supports longer, multi-line text for detailed information
- Good for instructions, lists, recipes, or structured information

### DashboardCard
- Designed for monitoring key metrics at a glance
- Clear label-value pairing helps with quick comprehension
- Works best with short values (numbers, brief status, etc.)
- Consider using in the [`DASHBOARD`](/reference/enums#viewtype) view for persistent display

### BitmapView
- Use for visual content like icons, simple diagrams, or charts
- Keep images simple and high-contrast for readability in AR
- Consider size and memory impact - optimize images when possible
- Test on actual hardware to ensure visibility and clarity 