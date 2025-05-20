import React, { useEffect, useState } from 'react';

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
    segments: Array<{
      resultId: string;
      text: string;
      timestamp: Date;
      isFinal: boolean;
    }>;
    languageSegments: Record<string, Array<{
      resultId: string;
      text: string;
      timestamp: Date;
      isFinal: boolean;
    }>>;
  };
  subscriptionManager: {
    subscriptions: Record<string, string[]>;
  };
  displayManager: {
    activeDisplay: {
      displayRequest: {
        packageName: string;
        layout: {
          layoutType: string;
          text?: string;
          title?: string;
        };
        timestamp: Date;
      };
      startedAt: Date;
    } | null;
    displayHistory: Array<{
      displayRequest: {
        packageName: string;
        layout: {
          layoutType: string;
          text?: string;
          title?: string;
        };
        timestamp: Date;
      };
      startedAt: Date;
    }>;
  };
  dashboardManager: {
    dashboardMode: string;
    alwaysOnEnabled: boolean;
    contentQueue: string[];
  };
  appConnections: Record<string, { readyState: number }>;
  lastAudioTimestamp: number;
  transcriptionStreams: Record<string, { status: string; language: string }>;
  audioBuffer: {
    chunks: any[];
    lastProcessedSequence: number;
    processingInProgress: boolean;
  };
  lc3Service: {
    initialized: boolean;
    status: string;
  } | null;
  recentEvents: Array<{
    time: string;
    description: string;
  }>;
}

interface SystemStats {
  activeSessions: number;
  totalSessions: number;
  activeTpas: number;
  totalTpas: number;
}

type DebuggerEvent = 
  | { type: 'SESSION_UPDATE'; sessionId: string; data: Partial<DebugSessionInfo> }
  | { type: 'SESSION_DISCONNECTED'; sessionId: string; timestamp: string }
  | { type: 'SESSION_CONNECTED'; sessionId: string; timestamp: string }
  | { type: 'TPA_STATE_CHANGE'; sessionId: string; tpaId: string; state: any }
  | { type: 'DISPLAY_UPDATE'; sessionId: string; display: any }
  | { type: 'TRANSCRIPTION_UPDATE'; sessionId: string; transcript: any }
  | { type: 'SYSTEM_STATS_UPDATE'; stats: SystemStats };

interface DebuggerEventsProps {
  onEvent?: (event: any) => void;
  onSessionsUpdate?: (sessions: any[], stats: any) => void;
}

export const DebuggerEvents: React.FC<DebuggerEventsProps> = ({ onEvent, onSessionsUpdate }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<any>(null);

  useEffect(() => {
    console.log('Connecting to SSE endpoint...');
    // The URL should match our cloud server's endpoint
    const eventSource = new EventSource('http://localhost:8002/api/debug/events');

    eventSource.onopen = () => {
      console.log('✅ SSE connection established');
      setIsConnected(true);
    };

    eventSource.onerror = (error) => {
      console.error('❌ SSE Error:', error);
      setIsConnected(false);
    };

    // Handle different event types
    eventSource.addEventListener('connected', (event) => {
      console.log('🔵 Connected event:', JSON.parse(event.data));
    });

    eventSource.addEventListener('sessions', (event) => {
      console.log('🔵 Sessions update:', JSON.parse(event.data));
      const { sessions, stats } = JSON.parse(event.data);
      onSessionsUpdate?.(sessions, stats);
    });

    eventSource.addEventListener('session_update', (event) => {
      console.log('🔵 Session update:', JSON.parse(event.data));
      const data = JSON.parse(event.data);
      setLastEvent(data);
      onEvent?.(data);
    });

    eventSource.addEventListener('tpa_state_change', (event) => {
      console.log('🔵 TPA state change:', JSON.parse(event.data));
      const data = JSON.parse(event.data);
      setLastEvent(data);
      onEvent?.(data);
    });

    eventSource.addEventListener('display_update', (event) => {
      console.log('🔵 Display update:', JSON.parse(event.data));
      const data = JSON.parse(event.data);
      setLastEvent(data);
      onEvent?.(data);
    });

    eventSource.addEventListener('transcription_update', (event) => {
      console.log('🔵 Transcription update:', JSON.parse(event.data));
      const data = JSON.parse(event.data);
      setLastEvent(data);
      onEvent?.(data);
    });

    eventSource.addEventListener('system_stats_update', (event) => {
      console.log('🔵 System stats update:', JSON.parse(event.data));
      const data = JSON.parse(event.data);
      setLastEvent(data);
      onEvent?.(data);
    });

    eventSource.addEventListener('heartbeat', (event) => {
      console.log('💓 Heartbeat:', JSON.parse(event.data));
    });

    return () => {
      console.log('Closing SSE connection...');
      eventSource.close();
      setIsConnected(false);
    };
  }, [onEvent, onSessionsUpdate]);

  return (
    <div className="p-4 bg-gray-900 rounded-lg text-white font-mono">
      <div className={`mb-4 p-2 rounded ${isConnected ? 'bg-green-900' : 'bg-red-900'}`}>
        Status: {isConnected ? 'Connected' : 'Disconnected'}
      </div>
      {lastEvent && (
        <div className="bg-gray-800 p-4 rounded overflow-x-auto">
          <h3 className="text-gray-400 text-sm uppercase mb-2">Last Event:</h3>
          <pre className="text-sm whitespace-pre-wrap break-words leading-relaxed">
            {JSON.stringify(lastEvent, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}; 