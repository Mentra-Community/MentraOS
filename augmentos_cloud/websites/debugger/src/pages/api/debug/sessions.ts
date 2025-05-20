import axios from 'axios';

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

interface ApiResponse {
  sessions: DebugSessionInfo[];
  stats: SystemStats;
}

const API_BASE_URL = import.meta.env.DEV ? 'http://localhost:8002' : '';

export async function fetchSessions(): Promise<ApiResponse> {
  try {
    const response = await axios.get(`${API_BASE_URL}/api/debug/sessions`);
    return response.data;
  } catch (error) {
    console.error('Error fetching session data:', error);
    return {
      sessions: [],
      stats: {
        activeSessions: 0,
        totalSessions: 0,
        activeTpas: 0,
        totalTpas: 0
      }
    };
  }
} 