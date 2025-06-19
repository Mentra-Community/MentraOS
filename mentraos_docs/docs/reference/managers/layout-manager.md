---
sidebar_position: 2
title: LayoutManager
---

# LayoutManager

The `LayoutManager` is responsible for sending display requests to AugmentOS Cloud to show layouts in the AR view. It provides methods for displaying different types of content in the user's field of view.

You access the LayoutManager through the `layouts` property of a [`TpaSession`](/reference/tpa-session) instance:

```typescript
const layoutManager = tpaSession.layouts;
```

## Layout Methods

### showTextWall()

Displays a single, primary block of text.

```typescript
showTextWall(
  text: string, 
  options?: { 
    view?: ViewType; 
    durationMs?: number 
  }
): void
```

**Parameters:**
- `text`: The text content to display
- `options`: Optional parameters
  - `view`: Target view ([`ViewType.MAIN`](/reference/enums#viewtype) or [`ViewType.DASHBOARD`](/reference/enums#viewtype)). Defaults to `MAIN`
  - `durationMs`: Optional duration in milliseconds to show the layout

**Example:**
```typescript
import { ViewType } from '@augmentos/sdk';

// Simple usage
tpaSession.layouts.showTextWall('Hello, AugmentOS!');

// With options
tpaSession.layouts.showTextWall('This is an important message', {
  view: ViewType.MAIN,
  durationMs: 5000 // Show for 5 seconds
});
```

### showDoubleTextWall()

Displays two blocks of text, one above the other.

```typescript
showDoubleTextWall(
  topText: string, 
  bottomText: string, 
  options?: { 
    view?: ViewType; 
    durationMs?: number 
  }
): void
```

**Parameters:**
- `topText`: Text for the top section
- `bottomText`: Text for the bottom section
- `options`: Optional parameters
  - `view`: Target view ([`ViewType.MAIN`](/reference/enums#viewtype) or [`ViewType.DASHBOARD`](/reference/enums#viewtype)). Defaults to `MAIN`
  - `durationMs`: Optional duration in milliseconds

**Example:**
```typescript
// Show a title and content
tpaSession.layouts.showDoubleTextWall(
  'Weather Forecast',
  'Partly cloudy, 72°F, 10% chance of rain',
  { durationMs: 3000 }
);
```

### showReferenceCard()

Displays a card with a title and main content text.

```typescript
showReferenceCard(
  title: string, 
  text: string, 
  options?: { 
    view?: ViewType; 
    durationMs?: number 
  }
): void
```

**Parameters:**
- `title`: The title of the card
- `text`: The main content text of the card
- `options`: Optional parameters
  - `view`: Target view ([`ViewType.MAIN`](/reference/enums#viewtype) or [`ViewType.DASHBOARD`](/reference/enums#viewtype)). Defaults to `MAIN`
  - `durationMs`: Optional duration in milliseconds

**Example:**
```typescript
// Show a reference card with a recipe
tpaSession.layouts.showReferenceCard(
  'Chocolate Chip Cookies',
  '2 cups flour\n1 cup sugar\n1/2 cup butter\n2 eggs\n1 tsp vanilla\n2 cups chocolate chips\n\nMix ingredients. Bake at 350°F for 10-12 minutes.'
);
```

### showBitmapView()

Displays a bitmap image.

```typescript
showBitmapView(
  data: string, 
  options?: { 
    view?: ViewType; 
    durationMs?: number 
  }
): void
```

**Parameters:**
- `data`: A base64 encoded string of the bitmap data
- `options`: Optional parameters
  - `view`: Target view ([`ViewType.MAIN`](/reference/enums#viewtype) or [`ViewType.DASHBOARD`](/reference/enums#viewtype)). Defaults to `MAIN`
  - `durationMs`: Optional duration in milliseconds

**Example:**
```typescript
// Example with a base64-encoded image
const base64Image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...'; // truncated for brevity
tpaSession.layouts.showBitmapView(base64Image);
```

### showDashboardCard()

Displays a card suitable for dashboards, typically showing a key-value pair.

```typescript
showDashboardCard(
  leftText: string, 
  rightText: string, 
  options?: { 
    view?: ViewType; 
    durationMs?: number 
  }
): void
```

**Parameters:**
- `leftText`: Text for the left side (often a label)
- `rightText`: Text for the right side (often a value)
- `options`: Optional parameters
  - `view`: Target view ([`ViewType.MAIN`](/reference/enums#viewtype) or [`ViewType.DASHBOARD`](/reference/enums#viewtype)). Defaults to `DASHBOARD`
  - `durationMs`: Optional duration in milliseconds

**Example:**
```typescript
// Show current temperature in the dashboard
tpaSession.layouts.showDashboardCard('Temperature', '72°F');

// Show stock price in the main view
tpaSession.layouts.showDashboardCard('AAPL', '$178.72', { 
  view: ViewType.MAIN 
});
```

## Layout Types

The LayoutManager uses several layout types internally. For reference, these are:

### TextWall

```typescript
interface TextWall {
  layoutType: LayoutType.TEXT_WALL;
  text: string;
}
```

See the full definition in [Layout Types](/reference/interfaces/layout-types#textwall).

### DoubleTextWall

```typescript
interface DoubleTextWall {
  layoutType: LayoutType.DOUBLE_TEXT_WALL;
  topText: string;
  bottomText: string;
}
```

See the full definition in [Layout Types](/reference/interfaces/layout-types#doubletextwall).

### ReferenceCard

```typescript
interface ReferenceCard {
  layoutType: LayoutType.REFERENCE_CARD;
  title: string;
  text: string;
}
```

See the full definition in [Layout Types](/reference/interfaces/layout-types#referencecard).

### DashboardCard

```typescript
interface DashboardCard {
  layoutType: LayoutType.DASHBOARD_CARD;
  leftText: string;
  rightText: string;
}
```

See the full definition in [Layout Types](/reference/interfaces/layout-types#dashboardcard).

### BitmapView

```typescript
interface BitmapView {
  layoutType: LayoutType.BITMAP_VIEW;
  data: string; // Base64 encoded bitmap data
}
```

See the full definition in [Layout Types](/reference/interfaces/layout-types#bitmapview).

## View Types

The [`ViewType`](/reference/enums#viewtype) enum is used to specify where in the AR display the layout should appear:

```typescript
enum ViewType {
  DASHBOARD = 'dashboard', // The persistent dashboard area
  MAIN = 'main'            // The main, typically temporary, display area
}
```

## Best Practices

1. **Choose the Right Layout**: Select the layout type that best fits your content's structure.

2. **Keep Text Concise**: Screen space in AR glasses is limited. Keep your text brief and to the point.

3. **Use Duration Wisely**: 
   - For important information, use longer durations or no duration (persistent until replaced)
   - For notifications or transient information, use shorter durations (2-5 seconds)

4. **Dashboard vs. Main View**:
   - Use the [`DASHBOARD`](/reference/enums#viewtype) view for persistent information the user may need to reference
   - Use the [`MAIN`](/reference/enums#viewtype) view for temporary information or responses to user actions

5. **Bitmap Performance**: When using showBitmapView, optimize your images for performance and readability on AR displays:
   - Keep images small and simple
   - Use high contrast
   - Prefer PNG format for transparency support 