# Dashboard Testing System

## Overview

This document outlines the testing system for the AugmentOS Dashboard. The testing system provides a way to visualize dashboard behavior in the terminal during development, allowing for quick iteration and debugging without requiring actual smart glasses hardware.

## Testing Framework Design

The dashboard testing system consists of a test harness that provides:

1. Visual representation of dashboard displays in the terminal
2. Simulation of app lifecycle events (start, stop)
3. Simulation of content updates from various TPAs
4. Monitoring of content rotation through queues
5. Testing of app stop/cleanup behavior
6. Visual validation of dashboard composition

### Core Components

1. **DashboardTestHarness**: Main test coordination class
2. **TerminalVisualizer**: Renders dashboard layouts to the terminal
3. **TestScenario**: Defines a sequence of events to test specific functionality

## Terminal Visualization

The system will visualize each dashboard mode with ASCII art representations:

### Main Dashboard Mode
```
========================================
DASHBOARD MODE: main
----------------------------------------
TOP LEFT: 12:45 PM           TOP RIGHT: Battery: 85%
----------------------------------------
BOTTOM LEFT: Weather         BOTTOM RIGHT (TPA): Meeting in 5m
========================================
```

### Expanded Dashboard Mode
```
========================================
DASHBOARD MODE: expanded
----------------------------------------
TOP LEFT: 12:45 PM           TOP RIGHT (TPA): Weather 72°F
----------------------------------------
MAIN AREA: [TPA Content Area]
========================================
```

### Always-on Dashboard Mode
```
========================================
DASHBOARD MODE: always_on
----------------------------------------
TOP LEFT: 12:45 PM           TOP RIGHT (TPA): 2 notifications
----------------------------------------
MAIN AREA: [TPA Content Area]
========================================
```

## Test Harness

The test harness will be implemented as follows:

```typescript
class DashboardTestHarness {
  private dashboardManager: DashboardManager;
  private visualizer: TerminalVisualizer;
  
  constructor(dashboardManager: DashboardManager) {
    this.dashboardManager = dashboardManager;
    this.visualizer = new TerminalVisualizer();
  }

  // Display current state
  visualizeCurrentState(mode: DashboardMode): void {
    // Get content from dashboard manager
    const topLeft = this.dashboardManager.getTopLeft();
    const topRight = this.dashboardManager.getTopRight();
    const bottomLeft = this.dashboardManager.getBottomLeft();
    const bottomRight = this.dashboardManager.getBottomRight();
    const tpaContent = this.dashboardManager.getTpaContent(mode);
    
    // Display the layout in terminal
    this.visualizer.renderDashboard(mode, {
      topLeft,
      topRight,
      bottomLeft,
      bottomRight,
      tpaContent
    });
  }
  
  // Simulate app lifecycle events
  simulateAppStart(tpaId: string): void {
    console.log(`\n[TEST] App started: ${tpaId}`);
    // App start logic
  }
  
  simulateAppStop(tpaId: string): void {
    console.log(`\n[TEST] App stopped: ${tpaId}`);
    this.dashboardManager.removeTpa(tpaId);
    
    // Check for needed updates
    for (const mode of Object.values(DashboardMode)) {
      if (this.dashboardManager.needsImmediateUpdate(mode)) {
        console.log(`[TEST] Dashboard ${mode} needs immediate update after app stop`);
        this.visualizeCurrentState(mode);
      }
    }
  }
  
  // Simulate content updates
  simulateContentUpdate(tpaId: string, content: string, modes: DashboardMode[]): void {
    console.log(`\n[TEST] Content update from ${tpaId}: "${content}" for modes: ${modes.join(', ')}`);
    this.dashboardManager.addOrUpdateContent(tpaId, content, modes);
    
    // Show updated display for affected modes
    modes.forEach(mode => this.visualizeCurrentState(mode));
  }
  
  // Run test scenarios
  runTestScenario(scenario: TestScenario): void {
    console.log(`\n[TEST] Running scenario: ${scenario.name}`);
    scenario.events.forEach(event => this.processEvent(event));
    this.summarizeResults();
  }
  
  // Process a test event
  private processEvent(event: TestEvent): void {
    switch (event.type) {
      case 'app_start':
        this.simulateAppStart(event.tpaId);
        break;
      case 'app_stop':
        this.simulateAppStop(event.tpaId);
        break;
      case 'content_update':
        this.simulateContentUpdate(event.tpaId, event.content, event.modes);
        break;
      case 'mode_change':
        this.dashboardManager.setMode(event.mode);
        this.visualizeCurrentState(event.mode);
        break;
      case 'rotate_content':
        for (let i = 0; i < (event.count || 1); i++) {
          const content = this.dashboardManager.getNextContent(event.mode);
          console.log(`[TEST] Rotation ${i+1}, content: "${content}"`);
          this.visualizeCurrentState(event.mode);
        }
        break;
    }
  }
  
  // Output test summary
  private summarizeResults(): void {
    console.log("\n[TEST] Final dashboard states:");
    Object.values(DashboardMode).forEach(mode => {
      this.visualizeCurrentState(mode);
    });
  }
}
```

## Test Scenarios

The testing system supports defining reusable test scenarios:

```typescript
interface TestScenario {
  name: string;
  description: string;
  events: TestEvent[];
}

type TestEvent = 
  | { type: 'app_start'; tpaId: string }
  | { type: 'app_stop'; tpaId: string }
  | { type: 'content_update'; tpaId: string; content: string; modes: DashboardMode[] }
  | { type: 'mode_change'; mode: DashboardMode }
  | { type: 'rotate_content'; mode: DashboardMode; count?: number };
```

## Sample Test Scenarios

### Basic Functionality Test

Tests basic dashboard operations:
- App content updates
- Content rotation
- Dashboard mode switching

### App Lifecycle Test

Tests app behavior during lifecycle events:
- Content cleanup when apps stop
- Queue integrity after app removal
- Immediate display updates when active app stops

### Load Test

Tests system behavior under high load:
- Many concurrent TPAs
- Rapid content updates
- Performance metrics

## Running Tests

Tests can be run manually during development:

```typescript
// Initialize dashboard manager
const dashboardManager = new DashboardManager();

// Initialize test harness
const testHarness = new DashboardTestHarness(dashboardManager);

// Run a test scenario
testHarness.runTestScenario(basicFunctionalityTest);
```

Or automated via command line:

```bash
npm run test:dashboard
```

## Integration with CI/CD

The testing system can be integrated with CI/CD pipelines to ensure dashboard functionality remains correct:

1. Automated tests run on every PR
2. Tests generate visual output logs for review
3. Performance metrics are tracked over time

## Extending the Testing System

The testing system is designed to be extensible:

1. New test scenarios can be added by defining new event sequences
2. Custom visualizations can be implemented for different output formats
3. Performance instrumentation can be added for profiling
4. Recording and replay of real-world usage patterns