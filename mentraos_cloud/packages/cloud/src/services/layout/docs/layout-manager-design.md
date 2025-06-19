# Layout Manager Design Document

## Overview

The Layout Manager is a centralized system responsible for building and managing display layouts for smart glasses. It handles the "final mile" of layout building before content is sent to the client, ensuring consistent rendering across different device types while maintaining the flexibility of different layout types.

## Problem Statement

Currently, layout building logic is distributed across different components:
1. Display Manager handles regular display requests
2. Dashboard Manager handles dashboard content
3. Each device type has its own layout implementation
4. Always-on dashboard requires complex coordination between managers

This leads to:
- Inconsistent layout rendering across devices
- Duplicated layout building logic
- Complex timing management
- Difficulty in adding new device support
- Complex always-on dashboard implementation

## Solution

Centralize all layout building in a new Layout Manager that:
1. Handles all layout building for all device types
2. Manages timing and state for both display and dashboard content
3. Converts all layouts to text walls for client display
4. Handles device-specific layout requirements
5. Manages always-on dashboard combination

## Core Components

### 1. Device Types and Configuration

```typescript
enum DeviceType {
  G1 = 'g1',
  ULTRALITE = 'ultralite'
}

// Static device configurations
const DEVICE_CONFIGS = {
  [DeviceType.G1]: {
    displayWidth: 640,
    maxLines: 5,  // Total lines available
    layoutRules: {
      doubleTextWall: {
        leftColumnRatio: 0.5,
        rightColumnRatio: 0.5,
        columnSpacing: 10
      }
    }
  }
} as const;
```

### 2. Font Utility

The font utility is crucial for precise text positioning, especially for the G1 device:

```typescript
interface FontUtility {
  getCharacterWidth(char: string): number;
  getTextWidth(text: string): number;
  calculateTextFit(text: string, maxWidth: number): {
    fits: boolean;
    width: number;
    charactersThatFit: number;
  };
}

// G1 Implementation
class G1FontUtility implements FontUtility {
  private fontMap: Map<string, number>;

  constructor() {
    // Load font metrics from g1_fonts.json
    this.fontMap = this.loadFontMetrics();
  }

  getTextWidth(text: string): number {
    return text.split('').reduce((width, char) => {
      return width + this.getCharacterWidth(char);
    }, 0);
  }

  calculateTextFit(text: string, maxWidth: number): {
    fits: boolean;
    width: number;
    charactersThatFit: number;
  } {
    let currentWidth = 0;
    let charactersThatFit = 0;

    for (const char of text) {
      const charWidth = this.getCharacterWidth(char);
      if (currentWidth + charWidth > maxWidth) {
        break;
      }
      currentWidth += charWidth;
      charactersThatFit++;
    }

    return {
      fits: charactersThatFit === text.length,
      width: currentWidth,
      charactersThatFit
    };
  }
}
```

### 3. Layout Manager Core

```typescript
interface DisplayState {
  content: DisplayRequest;
  expiresAt: number | null;  // null means no expiration
}

class FinalMileLayoutManager {
  private displayManagerState: DisplayState | null = null;
  private dashboardManagerState: DisplayState | null = null;
  private currentLayout: TextWallLayout | null = null;
  private layoutTimeout: NodeJS.Timeout | null = null;

  constructor(
    private fontUtilities: Map<DeviceType, FontUtility>,
    private sendToClient: (layout: TextWallLayout) => void
  ) {}

  // Called by Display Manager
  updateDisplayManagerState(request: DisplayRequest): void {
    this.displayManagerState = {
      content: request,
      expiresAt: request.durationMs ? Date.now() + request.durationMs : null
    };
    this.rebuildAndScheduleLayout();
  }

  // Called by Dashboard Manager
  updateDashboardManagerState(request: DisplayRequest): void {
    this.dashboardManagerState = {
      content: request,
      expiresAt: request.durationMs ? Date.now() + request.durationMs : null
    };
    this.rebuildAndScheduleLayout();
  }

  private rebuildAndScheduleLayout(): void {
    // Clear any existing timeout
    if (this.layoutTimeout) {
      clearTimeout(this.layoutTimeout);
    }

    // Build new layout
    this.currentLayout = this.buildCurrentLayout();
    this.sendToClient(this.currentLayout);

    // Schedule next rebuild
    this.scheduleNextRebuild();
  }
}
```

## Layout Types and Building

### 1. Text Wall
Basic text display, full width:
```typescript
private buildTextWall(
  text: string,
  deviceConfig: typeof DEVICE_CONFIGS[DeviceType],
  fontUtility: FontUtility
): TextWallLayout {
  // Calculate text wrapping
  const lines = this.wrapTextToLines(
    text,
    deviceConfig.maxLines,
    deviceConfig.displayWidth,
    fontUtility
  );

  return {
    type: 'text_wall',
    lines
  };
}
```

### 2. Double Text Wall
Two columns with precise width calculation:
```typescript
private buildDoubleTextWall(
  text1: string,
  text2: string,
  deviceConfig: typeof DEVICE_CONFIGS[DeviceType],
  fontUtility: FontUtility
): TextWallLayout {
  const { leftColumnRatio, rightColumnRatio, columnSpacing } = 
    deviceConfig.layoutRules.doubleTextWall;

  const leftWidth = deviceConfig.displayWidth * leftColumnRatio;
  const rightWidth = deviceConfig.displayWidth * rightColumnRatio;

  // Calculate text fits
  const leftFit = fontUtility.calculateTextFit(text1, leftWidth);
  const rightFit = fontUtility.calculateTextFit(text2, rightWidth);

  // Build columns with proper spacing
  const leftLines = this.wrapTextToLines(
    text1,
    deviceConfig.maxLines,
    leftWidth,
    fontUtility
  );

  const rightLines = this.wrapTextToLines(
    text2,
    deviceConfig.maxLines,
    rightWidth,
    fontUtility
  );

  return {
    type: 'double_text_wall',
    leftLines,
    rightLines,
    columnSpacing
  };
}
```

### 3. Always-On Dashboard
Combines status bar with main content:
```typescript
private buildAlwaysOnLayout(
  dashboardContent: DisplayRequest | null,
  mainContent: DisplayRequest | null,
  deviceConfig: typeof DEVICE_CONFIGS[DeviceType],
  fontUtility: FontUtility
): TextWallLayout {
  // Build status bar (1 line)
  const statusBar = dashboardContent 
    ? this.formatStatusBar(dashboardContent, deviceConfig, fontUtility)
    : '';

  // Build main content (4 lines for G1)
  const mainContentLines = mainContent
    ? this.formatMainContent(mainContent, deviceConfig, fontUtility)
    : [];

  // Combine into final layout
  return {
    type: 'always_on',
    statusBar,
    mainContent: mainContentLines,
    maxLines: deviceConfig.maxLines
  };
}
```

## Integration Points

### 1. Display Manager
```typescript
class DisplayManager {
  constructor(
    private layoutManager: FinalMileLayoutManager
  ) {}

  handleDisplayEvent(request: DisplayRequest, userSession: UserSession): boolean {
    // Send to layout manager instead of building layout directly
    this.layoutManager.updateDisplayManagerState(request);
    return true;
  }
}
```

### 2. Dashboard Manager
```typescript
class DashboardManager {
  constructor(
    private layoutManager: FinalMileLayoutManager
  ) {}

  updateDashboard(content: DashboardContent, userSession: UserSession): void {
    // Send to layout manager instead of building layout directly
    this.layoutManager.updateDashboardManagerState(content);
  }
}
```

### 3. User Session
```typescript
interface UserSession {
  // Existing fields...
  deviceType: DeviceType;  // Only need device type
}
```

## Key Implementation Details

1. **Layout Building**:
   - All layouts are converted to text walls
   - Font utilities handle precise text positioning
   - Device-specific rules are applied during building

2. **Timing Management**:
   - Tracks expiration for both display and dashboard content
   - Automatically rebuilds layout when content expires
   - Handles overlapping display requests

3. **Always-On Dashboard**:
   - Combines status bar with main content
   - Handles timing for both components
   - Maintains proper line count

4. **Device Support**:
   - Static device configurations
   - Device-specific font utilities
   - Device-specific layout rules

## Important Considerations

1. **Font Metrics**:
   - Critical for precise text positioning
   - Different for each device type
   - Must be loaded from device-specific files

2. **Line Count**:
   - G1 has 5 total lines
   - Always-on uses 1 line for status bar
   - Main content limited to remaining lines

3. **Timing**:
   - Both display and dashboard can have timers
   - Layout must be rebuilt when either expires
   - Always-on status bar can persist

4. **Layout Types**:
   - All ultimately convert to text walls
   - Device-specific formatting rules apply
   - Font utilities handle precise positioning 

## Current Client-Side Layout Building

### 1. Display Manager (augmentos_manager)
Currently handles layout building in `DisplayManager`:
```typescript
class DisplayManager {
  private buildLayout(request: DisplayRequest, userSession: UserSession): TextWallLayout {
    // Currently builds layouts directly
    switch (request.type) {
      case 'text_wall':
        return this.buildTextWall(request.text, userSession);
      case 'double_text_wall':
        return this.buildDoubleTextWall(request.text1, request.text2, userSession);
      // ... other layout types
    }
  }

  private buildTextWall(text: string, userSession: UserSession): TextWallLayout {
    // Currently uses client-side font utilities
    const fontUtility = this.getFontUtility(userSession.deviceType);
    const lines = this.wrapTextToLines(text, fontUtility);
    return { type: 'text_wall', lines };
  }
}
```

### 2. Dashboard Manager (augmentos_core)
Currently handles dashboard layouts:
```typescript
class DashboardManager {
  private buildDashboardLayout(content: DashboardContent): TextWallLayout {
    // Currently builds dashboard layouts directly
    const statusBar = this.buildStatusBar(content);
    const mainContent = this.buildMainContent(content);
    return this.combineDashboardLayout(statusBar, mainContent);
  }
}
```

### 3. Font Utilities
Currently distributed across client components:
```typescript
// In augmentos_core
class G1FontUtility {
  private fontMetrics: Map<string, number>;

  constructor() {
    // Currently loads font metrics from client-side JSON
    this.fontMetrics = this.loadFontMetrics();
  }
}

// In augmentos_manager
class DisplayFontUtility {
  // Similar implementation for display-specific fonts
}
```

## Migration to Cloud-Side

### 1. Layout Building Migration
Move all layout building to cloud:
```typescript
// In augmentos_cloud
class FinalMileLayoutManager {
  // ... existing code ...

  private buildCurrentLayout(): TextWallLayout {
    const deviceConfig = this.getDeviceConfig(this.userSession.deviceType);
    const fontUtility = this.getFontUtility(this.userSession.deviceType);

    if (this.isAlwaysOnDashboard()) {
      return this.buildAlwaysOnLayout(
        this.dashboardManagerState?.content,
        this.displayManagerState?.content,
        deviceConfig,
        fontUtility
      );
    }

    return this.buildRegularLayout(
      this.displayManagerState?.content,
      deviceConfig,
      fontUtility
    );
  }
}

// In augmentos_manager (simplified)
class DisplayManager {
  constructor(private layoutManager: FinalMileLayoutManager) {}

  handleDisplayEvent(request: DisplayRequest): void {
    // Simply forward to cloud
    this.layoutManager.updateDisplayManagerState(request);
  }
}
```

### 2. Font Utility Migration
Move font utilities to cloud:
```typescript
// In augmentos_cloud
class CloudFontUtilityManager {
  private fontUtilities: Map<DeviceType, FontUtility>;

  constructor() {
    this.fontUtilities = new Map([
      [DeviceType.G1, new G1FontUtility()],
      [DeviceType.ULTRALITE, new UltraliteFontUtility()]
    ]);
  }

  getFontUtility(deviceType: DeviceType): FontUtility {
    const utility = this.fontUtilities.get(deviceType);
    if (!utility) {
      throw new Error(`No font utility for device type: ${deviceType}`);
    }
    return utility;
  }
}
```

### 3. Device Configuration Migration
Move device configurations to cloud:
```typescript
// In augmentos_cloud
const DEVICE_CONFIGS = {
  [DeviceType.G1]: {
    displayWidth: 640,
    maxLines: 5,
    layoutRules: {
      doubleTextWall: {
        leftColumnRatio: 0.5,
        rightColumnRatio: 0.5,
        columnSpacing: 10
      }
    }
  }
} as const;

// In augmentos_manager (simplified)
interface UserSession {
  deviceType: DeviceType;  // Only need device type, config moved to cloud
}
```

### 4. Client-Side Changes
Simplify client components:
```typescript
// In augmentos_manager
class DisplayManager {
  constructor(
    private layoutManager: FinalMileLayoutManager,
    private sendToClient: (layout: TextWallLayout) => void
  ) {}

  handleDisplayEvent(request: DisplayRequest): void {
    // Forward to cloud
    this.layoutManager.updateDisplayManagerState(request);
  }

  // Client only needs to handle sending layouts to device
  handleLayoutUpdate(layout: TextWallLayout): void {
    this.sendToClient(layout);
  }
}

// In augmentos_core
class DashboardManager {
  constructor(
    private layoutManager: FinalMileLayoutManager
  ) {}

  updateDashboard(content: DashboardContent): void {
    // Forward to cloud
    this.layoutManager.updateDashboardManagerState(content);
  }
}
```

## Migration Benefits

1. **Centralized Layout Building**:
   - Single source of truth for layouts
   - Consistent rendering across devices
   - Easier to maintain and update

2. **Simplified Client Code**:
   - Clients only handle display and input
   - No layout building logic
   - Reduced code duplication

3. **Better Device Support**:
   - Device configurations in one place
   - Easier to add new devices
   - Consistent font handling

4. **Improved Always-On Dashboard**:
   - Centralized dashboard management
   - Better timing coordination
   - Consistent status bar handling

## Migration Steps

1. **Phase 1: Cloud Infrastructure**
   - Implement Layout Manager
   - Move font utilities
   - Set up device configurations

2. **Phase 2: Client Updates**
   - Update Display Manager
   - Update Dashboard Manager
   - Remove client-side layout building

3. **Phase 3: Integration**
   - Connect clients to cloud
   - Test layout building
   - Verify timing management

4. **Phase 4: Cleanup**
   - Remove old client code
   - Update documentation
   - Add monitoring 

## File Structure and System Operation

### 1. Cloud-Side (augmentos_cloud)

#### New Files
```
augmentos_cloud/packages/cloud/src/services/layout/
├── FinalMileLayoutManager.ts           # Main layout manager implementation
├── layout.types.ts                     # All layout-related types and interfaces
├── utils/
│   ├── G1FontUtility.ts               # G1-specific font implementation
│   ├── UltraliteFontUtility.ts        # Ultralite-specific font implementation
│   └── FontMetricsLoader.ts           # Font metrics loading utility
└── config/
    └── deviceConfigs.ts               # Device-specific configurations
```

#### Modified Files
```
augmentos_cloud/packages/cloud/src/services/
├── dashboard/
│   └── DashboardManager.ts            # Add layout building capability
└── layout/
    └── DisplayManager.ts              # Add layout building capability
```

### Current System Operation

1. **Display Request Flow**:
   ```
   TPA/System App -> Cloud (DisplayManager) -> Client (augmentos_manager) -> Device
   ```
   - TPA or System App sends display request to cloud
   - Cloud's DisplayManager receives request
   - DisplayManager forwards request to client
   - Client builds layout using its own logic
   - Client sends layout to device

2. **Dashboard Content Flow**:
   ```
   TPA/System App -> Cloud (DashboardManager) -> Client (augmentos_core) -> Device
   ```
   - TPA or System App sends dashboard content to cloud
   - DashboardManager receives content
   - DashboardManager forwards content to client
   - Client builds dashboard layout
   - Client sends layout to device

3. **Current Responsibilities**:
   - Cloud: Request routing and state management
   - Client: Layout building and device communication
   - Each component has its own font utilities
   - Layout building logic duplicated across components

### New System Operation

1. **Display Request Flow**:
   ```
   TPA/System App -> Cloud (DisplayManager) -> Cloud (LayoutManager) -> Device
                                          -> Client (augmentos_manager) [fallback]
   ```
   - TPA or System App sends display request to cloud
   - DisplayManager receives request
   - LayoutManager builds layout
   - Layout sent directly to device
   - Client still receives request as fallback

2. **Dashboard Content Flow**:
   ```
   TPA/System App -> Cloud (DashboardManager) -> Cloud (LayoutManager) -> Device
                                            -> Client (augmentos_core) [fallback]
   ```
   - TPA or System App sends dashboard content to cloud
   - DashboardManager receives content
   - LayoutManager builds dashboard layout
   - Layout sent directly to device
   - Client still receives content as fallback

### Key Changes

1. **New Cloud Files**:
   - `FinalMileLayoutManager.ts`: Implements centralized layout building
   - `layout.types.ts`: Contains all layout-related types:
     - Layout type definitions
     - Device configuration types
     - Font utility interface
     - Display state interfaces
     - Layout building interfaces
   - `G1FontUtility.ts`: Implements G1-specific font handling
   - `deviceConfigs.ts`: Contains device-specific configurations

2. **Modified Cloud Files**:
   - `DashboardManager.ts`: 
    - For the always on display, Instead of sending display requests directly to client, send them `FinalMileLayoutManager.ts` to handling building and timing of layout.
   - `DisplayManager.ts`:
     - Instead of sending display requests directly to client, send to `FinalMileLayoutManager.ts` which will build and combine layo

### Migration Approach

1. **Phase 1: Cloud Implementation**
   - Implement new Layout Manager
   - Add font utilities
   - Set up device configurations
   - No changes to client code

2. **Phase 2: Cloud Integration**
   - Add layout building to cloud
   - Build layouts before forwarding requests to client
   - Send built layouts to device
   - Keep request forwarding to client as fallback

3. **Phase 3: Verification**
   - Test cloud layout building
   - Verify device compatibility
   - Ensure no client disruption
   - Monitor performance

4. **Future Phase: Client Cleanup**
   - Only after cloud implementation is stable
   - Remove duplicate layout building
   - Update client dependencies
   - Not part of initial migration 