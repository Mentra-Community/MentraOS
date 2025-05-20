# Dashboard System Codebase Map

This document provides a map of the dashboard system codebase, explaining the purpose and relationships between files.

## Core Files

### Dashboard Manager Implementation

- **`/packages/cloud/src/services/dashboard/DashboardManager.ts`**
  - Core implementation of the dashboard manager
  - Manages content from TPAs and system dashboard
  - Handles message processing and display updates
  - Integrates with WebSocket and Display services

### SDK Types and Interfaces

- **`/packages/sdk/src/types/dashboard/index.ts`**
  - Contains dashboard-related type definitions
  - Defines `DashboardMode` enum for different view modes
  - Defines API interfaces (`DashboardSystemAPI`, `DashboardContentAPI`)
  - Defines message types for dashboard communication

### SDK Implementation

- **`/packages/sdk/src/tpa/session/dashboard.ts`**
  - Implements dashboard functionality for TPAs
  - Creates appropriate API based on TPA type (system vs. regular)
  - Handles message creation and sending
  - Provides convenience methods for common dashboard operations

### Constants and System App Definitions

- **`/packages/sdk/src/constants/index.ts`**
  - Defines system app package names
  - Used to identify the system dashboard TPA
  - Controls access to privileged dashboard functionality

### Message Type Definitions

- **`/packages/sdk/src/types/message-types.ts`**
  - Defines message type enums for dashboard communication
  - Includes both TPA-to-Cloud and Cloud-to-TPA message types
  - Provides message type constants for dashboard operations

## Test Files

- **`/packages/cloud/src/services/dashboard/tests/DashboardTestHarness.ts`**
  - Testing framework for dashboard functionality
  - Simulates WebSocket and Display services
  - Provides methods to simulate TPA actions and system events
  - Includes pre-built test scenarios

- **`/packages/cloud/src/services/dashboard/tests/run-tests.ts`**
  - Script to run dashboard tests
  - Creates test harness and executes test scenarios
  - Provides terminal output of test results

## Documentation Files

- **`/packages/cloud/src/services/dashboard/docs/dashboard-design.md`**
  - Comprehensive design document for the dashboard system
  - Explains dashboard modes, content management, and API design
  - Details message types and integration points

- **`/packages/cloud/src/services/dashboard/docs/dashboard-testing.md`**
  - Testing strategy and approach for the dashboard system
  - Explains test harness functionality and how to run tests
  - Provides examples of test output and custom test creation

- **`/packages/cloud/src/services/dashboard/docs/codebase-map.md`**
  - This file - maps all dashboard-related code
  - Explains file purposes and relationships

## Integration Files

### TPA Session Integration

- **`/packages/sdk/src/tpa/session/index.ts`**
  - Main TPA session class that exposes dashboard functionality
  - Creates and initializes dashboard API
  - Handles dashboard-related message processing

### WebSocket Service Integration

- **`/packages/cloud/src/services/core/websocket.service.ts`**
  - WebSocket service that processes dashboard messages
  - Registers message handlers from dashboard manager
  - Tracks TPA connections and disconnections

### Display Manager Integration

- **`/packages/cloud/src/services/display/DisplayManager.ts`**
  - Renders dashboard layouts to the glasses display
  - Handles throttling and optimization of display updates
  - Provides methods for showing both main content and overlays

## Flow of Execution

1. **Initialization**:
   - Cloud service creates DashboardManager instance
   - DashboardManager registers handlers with WebSocketService
   - TpaSession creates dashboard API during initialization

2. **Dashboard Content Flow**:
   - TPA calls dashboard API methods (e.g., `writeToMain`)
   - Dashboard API creates appropriate message
   - Message sent to cloud via WebSocket
   - DashboardManager processes message and updates content
   - DashboardManager generates layout and sends to DisplayManager
   - DisplayManager renders layout on glasses

3. **Dashboard Mode Changes**:
   - System dashboard TPA changes mode
   - Mode change message sent to cloud
   - DashboardManager updates mode and notifies all TPAs
   - TPAs receive mode change notification via events
   - DashboardManager updates display based on new mode