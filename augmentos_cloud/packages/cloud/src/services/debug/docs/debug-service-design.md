AugmentOS Debugger UI Design Document
1. Introduction
1.1 Purpose
The AugmentOS Debugger UI is a web-based monitoring and debugging tool that provides real-time visibility into the AugmentOS cloud system. It enables developers and operators to inspect user sessions, monitor TPAs (Third-Party Applications), track system state, and diagnose issues within the system.
1.2 Scope
This document outlines the design and implementation of the AugmentOS Debugger UI, focusing on the MVP (Minimum Viable Product) requirements, architecture, and UI components. It serves as a guide for the development team working on the debugger interface.
1.3 System Context
The debugger is a part of the AugmentOS cloud ecosystem and interacts primarily with the following components:

Session Service: Manages user sessions and their state
WebSocket Service: Handles real-time communication
TPA Service: Manages third-party applications
Display Service: Controls what is shown on the glasses

2. Requirements
2.1 MVP Requirements
The MVP version of the debugger should provide:

Session Monitoring

View all active user sessions
Inspect detailed session state
Monitor session lifecycle events


TPA Inspection

View active TPAs for each session
Monitor TPA subscriptions
Track TPA connection status


Display Visualization

View current display state
See display request history
Basic visualization of layout types


Audio & Transcription Monitoring

Track transcription status
Monitor audio input
View recent transcriptions


System Overview

View key system metrics
Track active sessions and TPAs
Monitor system health



2.2 Future Requirements (Post-MVP)
Features to be implemented after the MVP:

Advanced Display Request Analysis

Playback of display sequences
Visual comparison of layouts
Timeline-based visualization


Performance Monitoring

Resource usage tracking
Bottleneck identification
Historical performance trends


Debugger APIs

Remote control capabilities
Programmatic access to debugging data
Custom plugin support


Multi-user Support

Role-based access control
Collaborative debugging
Shared sessions



3. Architecture
3.1 Overall Architecture
+------------------+      +-----------------+      +------------------+
|                  |      |                 |      |                  |
|  Debugger UI     |<---->|  Debugger API   |<---->|  AugmentOS Cloud |
|  (React/Tailwind)|      | (Server Events) |      |  System          |
|                  |      |                 |      |                  |
+------------------+      +-----------------+      +------------------+
                                  ^
                                  |
                         +------------------+
                         |                  |
                         |  DebugService    |
                         |                  |
                         +------------------+
3.2 Backend Service
3.2.1 DebugService
The DebugService will be a core backend component responsible for:

Session State Access: Providing safe access to session data
Data Transformation: Converting internal data structures to debugger-friendly formats
Event Generation: Creating and dispatching debug events for real-time updates
Command Handling: Processing debug commands (stop TPA, etc.)
Security: Enforcing access controls and data sanitization

Key methods in the DebugService:
typescriptclass DebugService {
  // Session access methods
  getAllSessions(): DebugSessionInfo[];
  getSessionDetails(sessionId: string): ExtendedDebugSessionInfo;
  
  // TPA management
  stopTpa(sessionId: string, tpaName: string): Promise<boolean>;
  
  // System stats
  getSystemStats(): SystemStats;
  
  // Event stream handling
  setupEventStream(res: Response): void;
  
  // Helper methods
  private transformSessionForDebugger(session: ExtendedUserSession): DebugSessionInfo;
  private sanitizeSessionData(session: ExtendedUserSession): DebugSessionInfo;
}
The DebugService will interface with the following AugmentOS services:

sessionService: To access user session data
webSocketService: To monitor communication status
tpaService: To control TPAs
System monitoring tools: For resource utilization stats

3.3 Components
3.2.1 Frontend Components

React Application: Core SPA handling UI rendering and state management
Tailwind CSS: Utility-first CSS framework for styling
State Management: React hooks for local state management

3.2.2 Backend Integration

Server-Sent Events (SSE): For real-time updates from server to client
REST API: For fetching historical data and system configuration
WebSocket (Optional): For bidirectional communication if needed

3.2.3 Data Flow

Initial data is fetched via REST API on page load
Real-time updates are streamed via SSE
User interactions (filtering, selection) handled client-side
Commands (stopping TPAs, etc.) sent via REST API

4. UI Design
4.1 Layout
The UI follows a split-panel layout:
+-----------------------------------------------------------------------+
| HEADER - Title, Controls, System Status                               |
+-----------------------------------------------------------------------+
| SYSTEM OVERVIEW - Key Metrics, Health Indicators                      |
+-----------------------------------------------------------------------+
|                    |                                                  |
| SESSIONS LIST      |  SESSION INSPECTOR                               |
|                    |                                                  |
| - Search           |  - Session Info                                  |
| - Filter           |  - State Tree                                    |
| - Session List     |  - Active TPAs                                   |
|                    |  - Display State                                 |
|                    |  - Audio & Transcription                         |
|                    |  - Recent Events                                 |
|                    |                                                  |
+--------------------+--------------------------------------------------+
4.2 Core Components
4.2.1 Header

System title and branding
Live update toggle
Refresh button
System-wide controls

4.2.2 System Overview

Active sessions counter
Active TPAs counter
Memory usage indicator
System uptime display

4.2.3 Sessions List

Searchable list of all sessions
Status indicators (active/disconnected)
Basic session metadata
Selection mechanism

4.2.4 Session Inspector

Session Information: Core session metadata
State Tree: Expandable view of complete session state
Active TPAs: List of TPAs with connection status and subscriptions
Display State: Current display and display history
Audio & Transcription: Audio status and recent transcriptions
Recent Events: Chronological list of session events

4.3 Interactive Elements

State Tree Navigator: Expandable/collapsible tree for deep state inspection
Search Field: For filtering sessions by ID, user, or TPA
TPA Action Buttons: View details and stop buttons for each TPA
Live Updates Toggle: Enable/disable real-time updates

5. Implementation Plan
5.1 Phase 1: Backend DebugService

Create debug.service.ts with necessary interfaces
Implement session data access and transformation
Setup SSE event generation
Build REST endpoints under /api/debugger/*
Add security and error handling

5.2 Phase 2: Core UI Framework

Set up React application with Tailwind CSS
Implement basic layout and navigation
Create mock data structures matching actual session format
Connect to backend API endpoints

5.3 Phase 3: Session Monitoring

Implement sessions list with search and filtering
Create session info panel
Develop state tree visualization component
Add error handling for missing properties

5.4 Phase 4: TPA and Display Monitoring

Implement TPA status visualization
Create display state visualization
Add audio and transcription monitoring
Build command interface for TPA control

5.5 Phase 5: Real-time Updates

Implement SSE connection for live updates
Add update indicators for changing values
Create polling fallback for browsers without SSE support
Optimize for handling frequent updates

5.6 Phase 6: Testing and Optimization

Browser compatibility testing
Performance optimization for large state trees
Edge case handling for various data states
Load testing with large session counts

6. Technical Details
6.1 State Tree Visualization
The state tree component is a recursive component that visualizes the nested structure of the session state:
javascriptconst StateTreeNode = ({ label, path, data, expandedNodes, toggleNode, depth }) => {
  // Is this node expanded?
  const isExpanded = expandedNodes[path];
  
  // Determine data type
  const isObject = data && typeof data === 'object' && !Array.isArray(data);
  const isArray = Array.isArray(data);
  const hasChildren = isObject || isArray;
  
  // Handle special cases (null, undefined, primitive values)
  
  // Render expandable node for objects and arrays
  // Render leaf node for primitive values
};
6.2 Real-time Updates
Real-time updates are handled using Server-Sent Events (SSE):
javascriptuseEffect(() => {
  if (liveUpdates) {
    // Connect to SSE endpoint
    const eventSource = new EventSource('/api/sessions/events');
    
    // Handle incoming events
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      updateSessionData(data);
    };
    
    // Clean up on unmount
    return () => eventSource.close();
  }
}, [liveUpdates]);
6.3 Session Data Structure
The session data structure mirrors the actual ExtendedUserSession from the AugmentOS cloud system:
typescriptinterface ExtendedUserSession {
  sessionId: string;
  userId: string;
  startTime: Date;
  disconnectedAt: Date | null;
  activeAppSessions: string[];
  installedApps: AppI[];
  loadingApps: Set<string>;
  subscriptionManager: {
    subscriptions: Record<string, string[]>;
  };
  displayManager: {
    activeDisplay: {
      displayRequest: DisplayRequest;
      startedAt: Date;
    } | null;
    displayHistory: Array<{
      displayRequest: DisplayRequest;
      startedAt: Date;
    }>;
  };
  isTranscribing: boolean;
  transcript: {
    segments: TranscriptSegment[];
    languageSegments: Record<string, TranscriptSegment[]>;
  };
  // Additional properties...
}
7. API Integration
7.1 REST Endpoints
All debugger endpoints will be organized under the /api/debugger/* path prefix:

GET /api/debugger/sessions: Fetch all active sessions
GET /api/debugger/sessions/:id: Fetch detailed session data
POST /api/debugger/sessions/:id/tpa/:tpaName/stop: Stop a TPA
GET /api/debugger/system/stats: Fetch system-wide statistics

7.2 SSE Endpoints
Real-time updates will be provided via:

/api/debugger/events/sessions: Stream of session update events
/api/debugger/events/system: Stream of system-wide events

7.3 Event Types
SSE will deliver the following event types:

session_created: New session created
session_updated: Session state changed
session_disconnected: Session disconnected
tpa_started: TPA started in a session
tpa_stopped: TPA stopped in a session
display_updated: Display content changed
transcription_updated: New transcription available

