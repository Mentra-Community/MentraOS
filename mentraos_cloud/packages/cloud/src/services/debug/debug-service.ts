import { TranscriptSegment } from '@augmentos/sdk';
import { Server as HTTPServer } from 'http';

interface SystemStats {
  activeSessions: number;
  totalSessions: number;
  activeTpas: number;
  totalTpas: number;
}

interface DebugSessionInfo {
  sessionId: string;
  userId: string;
  startTime: string;
  disconnectedAt: string | null;
  activeAppSessions: string[];
  installedApps: Array<{ packageName: string; name: string }>;
  loadingApps: Set<string>;
  isTranscribing: boolean;
  transcript: {
    segments: TranscriptSegment[];
    languageSegments?: Map<string, TranscriptSegment[]>;
  };
  subscriptionManager: {
    subscriptions: Record<string, string[]>;
  };
  displayManager: {
    activeDisplay: {
      displayRequest: {
        packageName: string;
        layout: any; // Accept any layout object structure
        timestamp: Date;
      };
      startedAt: Date;
    } | null;
    displayHistory: Array<{
      displayRequest: {
        packageName: string;
        layout: any; // Accept any layout object structure
        timestamp: Date;
      };
      startedAt: Date;
    }>;
  } | any; // Accept DisplayManager directly as well
  dashboardManager: {
    dashboardMode: string;
    alwaysOnEnabled: boolean;
    contentQueue: string[];
  } | any; // Accept any dashboard manager
  appConnections: Record<string, { readyState: number }>;
  lastAudioTimestamp: number | undefined;
  transcriptionStreams: Record<string, { status: string; language: string }>;
  audioBuffer: {
    chunks: any[];
    lastProcessedSequence: number;
    processingInProgress: boolean;
  } | any; // Accept any audio buffer structure
  lc3Service: {
    initialized: boolean;
    status: string;
  } | null;
  recentEvents: Array<{
    time: string;
    description: string;
  }>;
}

type DebuggerEvent =
  | { type: 'SESSION_UPDATE'; sessionId: string; data: Partial<DebugSessionInfo> }
  | { type: 'SESSION_DISCONNECTED'; sessionId: string; timestamp: string }
  | { type: 'SESSION_CONNECTED'; sessionId: string; timestamp: string }
  | { type: 'TPA_STATE_CHANGE'; sessionId: string; tpaId: string; state: any }
  | { type: 'DISPLAY_UPDATE'; sessionId: string; display: any }
  | { type: 'TRANSCRIPTION_UPDATE'; sessionId: string; transcript: any }
  | { type: 'SYSTEM_STATS_UPDATE'; stats: SystemStats };

export class DebugService {
  private clients = new Set<{ send: (data: string) => void }>();
  private sessions: Map<string, DebugSessionInfo> = new Map();
  private isActive = false;

  constructor(private server: HTTPServer) {
    // Only enable debug service in development or debug environments
    const env = process.env.NODE_ENV || 'production';
    if (env === 'development' || env === 'debug') {
      console.log(`🔍 [DebugService] Debug service ENABLED in ${env} environment`);
      this.isActive = true;
      this.setupRoutes();
    } else {
      console.log('🔒 [DebugService] Debug service DISABLED in production environment');
    }
  }

  private serializeSession(session: DebugSessionInfo): any {
    // Create a safe copy of the session data
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      startTime: session.startTime,
      disconnectedAt: session.disconnectedAt,
      activeAppSessions: Array.isArray(session.activeAppSessions) ? session.activeAppSessions : [],
      installedApps: Array.isArray(session.installedApps) ? session.installedApps : [],
      loadingApps: Array.from(session.loadingApps || []),
      isTranscribing: Boolean(session.isTranscribing),
      transcript: {
        segments: Array.isArray(session.transcript?.segments) ? session.transcript.segments : [],
        languageSegments: session.transcript?.languageSegments || {}
      },
      subscriptionManager: {
        subscriptions: session.subscriptionManager?.subscriptions ?
          Object.fromEntries(
            Object.entries(session.subscriptionManager.subscriptions)
              .map(([key, value]) => [key, Array.isArray(value) ? value : []])
          ) : {}
      },
      displayManager: {
        activeDisplay: session.displayManager?.activeDisplay ? {
          displayRequest: {
            packageName: session.displayManager.activeDisplay.displayRequest.packageName,
            layout: {
              layoutType: session.displayManager.activeDisplay.displayRequest.layout.layoutType,
              text: session.displayManager.activeDisplay.displayRequest.layout.text,
              title: session.displayManager.activeDisplay.displayRequest.layout.title
            },
            timestamp: session.displayManager.activeDisplay.displayRequest.timestamp
          },
          startedAt: session.displayManager.activeDisplay.startedAt
        } : null,
        displayHistory: Array.isArray(session.displayManager?.displayHistory) ?
          session.displayManager.displayHistory.map((item: any) => ({
            displayRequest: {
              packageName: item.displayRequest.packageName,
              layout: {
                layoutType: item.displayRequest.layout.layoutType,
                text: item.displayRequest.layout.text,
                title: item.displayRequest.layout.title
              },
              timestamp: item.displayRequest.timestamp
            },
            startedAt: item.startedAt
          })) : []
      },
      dashboardManager: {
        dashboardMode: session.dashboardManager?.dashboardMode || 'inactive',
        alwaysOnEnabled: Boolean(session.dashboardManager?.alwaysOnEnabled),
        contentQueue: Array.isArray(session.dashboardManager?.contentQueue) ?
          session.dashboardManager.contentQueue : []
      },
      appConnections: session.appConnections ?
        Object.fromEntries(
          Object.entries(session.appConnections)
            .map(([key, value]) => [key, { readyState: value?.readyState || 0 }])
        ) : {},
      lastAudioTimestamp: session.lastAudioTimestamp || 0,
      transcriptionStreams: session.transcriptionStreams || {},
      audioBuffer: {
        chunks: [], // Don't send actual chunks
        lastProcessedSequence: session.audioBuffer?.lastProcessedSequence || 0,
        processingInProgress: Boolean(session.audioBuffer?.processingInProgress)
      },
      lc3Service: session.lc3Service ? {
        initialized: Boolean(session.lc3Service.initialized),
        status: session.lc3Service.status || 'unknown'
      } : null,
      recentEvents: Array.isArray(session.recentEvents) ? session.recentEvents : []
    };
  }

  private setupRoutes() {
    // Double-check that we're in a development environment
    const env = process.env.NODE_ENV || 'production';
    if (env !== 'development' && env !== 'debug') {
      console.warn('🛑 [DebugService] Attempted to setup debug routes in production environment!');
      return; // Don't set up routes in production
    }
    
    console.log(`🔌 [DebugService] Setting up debug routes`);
    
    // Add middleware to handle SSE requests
    this.server.on('request', async (req, res) => {
      // Skip if not active (additional safety check)
      if (!this.isActive) return;
      
      try {
        const url = new URL(req.url || '', `http://${req.headers.host}`);

        // REST API endpoint for initial session data
        if (url.pathname === '/api/debug/sessions' && req.method === 'GET') {
          console.log(`🔍 [DebugService] Serving debug sessions data`);
          const stats = this.calculateSystemStats();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(JSON.stringify({
            sessions: Array.from(this.sessions.values()).map(session => this.serializeSession(session)),
            stats
          }));
          return;
        }

        // SSE endpoint for real-time updates
        if (url.pathname === '/api/debug/events' && req.method === 'GET') {
          console.log(`🔄 [DebugService] Starting SSE connection for debug events`);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400'
          });

          // Send initial connection message
          res.write(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

          // Send initial state
          const stats = this.calculateSystemStats();
          res.write(`event: sessions\ndata: ${JSON.stringify({
            sessions: Array.from(this.sessions.values()).map(session => this.serializeSession(session)),
            stats
          })}\n\n`);

          // Add client
          const client = {
            send: (data: string) => res.write(data)
          };
          this.clients.add(client);

          // Keep connection alive with heartbeats
          const heartbeat = setInterval(() => {
            res.write(`event: heartbeat\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);
          }, 30000);

          // Clean up on close
          req.on('close', () => {
            console.log(`👋 [DebugService] SSE client disconnected`);
            clearInterval(heartbeat);
            this.clients.delete(client);
          });

          return;
        }
      } catch (error) {
        console.error(`❌ [DebugService] Error handling debug request:`, error);
        // Send error response if possible
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error in debug service' }));
          }
        } catch (responseError) {
          console.error(`❌ [DebugService] Failed to send error response:`, responseError);
        }
      }
    });
  }

  private calculateSystemStats(): SystemStats {
    const activeSessions = Array.from(this.sessions.values()).filter(s => !s.disconnectedAt).length;
    const totalSessions = this.sessions.size;

    let activeTpas = 0;
    let totalTpas = 0;

    this.sessions.forEach(session => {
      totalTpas += (session.installedApps?.length || 0);
      activeTpas += (session.activeAppSessions?.length || 0);
    });

    return {
      activeSessions,
      totalSessions,
      activeTpas,
      totalTpas
    };
  }

  // Broadcast events to all connected clients
  private broadcastEvent(event: DebuggerEvent) {
    if (!this.isActive) return; // Skip if debug service is not active
    
    const message = `event: ${event.type.toLowerCase()}\ndata: ${JSON.stringify(event)}\n\n`;
    this.clients.forEach(client => {
      try {
        client.send(message);
      } catch (error) {
        console.error('[DebugService] Error sending message to client:', error);
        // Remove failed client
        this.clients.delete(client);
      }
    });
  }

  // Public methods for updating session state
  public updateSession(sessionId: string, data: Partial<DebugSessionInfo>) {
    if (!this.isActive) return; // Skip if debug service is not active
    
    const session = this.sessions.get(sessionId);
    if (session) {
      const updatedSession = { ...session, ...data };
      this.sessions.set(sessionId, updatedSession);
      this.broadcastEvent({
        type: 'SESSION_UPDATE',
        sessionId,
        data: this.serializeSession(updatedSession)
      });
    }
  }

  public sessionConnected(sessionId: string, session: DebugSessionInfo) {
    if (!this.isActive) return; // Skip if debug service is not active
    
    this.sessions.set(sessionId, session);
    this.broadcastEvent({
      type: 'SESSION_CONNECTED',
      sessionId,
      timestamp: new Date().toISOString()
    });
  }

  public sessionDisconnected(sessionId: string) {
    if (!this.isActive) return; // Skip if debug service is not active
    
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.set(sessionId, { ...session, disconnectedAt: new Date().toISOString() });
      this.broadcastEvent({
        type: 'SESSION_DISCONNECTED',
        sessionId,
        timestamp: new Date().toISOString()
      });
    }
  }

  public updateTPAState(sessionId: string, tpaId: string, state: any) {
    if (!this.isActive) return; // Skip if debug service is not active
    
    this.broadcastEvent({
      type: 'TPA_STATE_CHANGE',
      sessionId,
      tpaId,
      state
    });
  }

  public updateDisplay(sessionId: string, display: any) {
    if (!this.isActive) return; // Skip if debug service is not active
    
    this.broadcastEvent({
      type: 'DISPLAY_UPDATE',
      sessionId,
      display
    });
  }

  public updateTranscription(sessionId: string, transcript: any) {
    if (!this.isActive) return; // Skip if debug service is not active
    
    this.broadcastEvent({
      type: 'TRANSCRIPTION_UPDATE',
      sessionId,
      transcript
    });
  }

  public updateSystemStats() {
    if (!this.isActive) return; // Skip if debug service is not active
    
    this.broadcastEvent({
      type: 'SYSTEM_STATS_UPDATE',
      stats: this.calculateSystemStats()
    });
  }
} 