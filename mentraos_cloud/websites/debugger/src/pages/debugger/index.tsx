import { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, RefreshCw, Search, X, Eye, PowerOff, AlertCircle, Home } from 'lucide-react';
import { StateTreeNode } from './components/StateTreeNode';
import { SystemOverview } from './components/SystemOverview';
import { SessionList } from './components/SessionList';
import { SessionInspector } from './components/SessionInspector';
import { DebuggerEvents } from '../../components/DebuggerEvents';
import { fetchSessions } from '../api/debug/sessions';

// Types
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

/**
 * AugmentOS Debugger Page
 * 
 * A comprehensive debugging interface for AugmentOS cloud system that allows:
 * - Viewing all active user sessions
 * - Inspecting detailed session state
 * - Monitoring TPAs and their subscriptions
 * - Checking display state and history
 * - Viewing recent events
 */
export default function DebuggerPage() {
  // State for sessions data
  const [sessions, setSessions] = useState<DebugSessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [liveUpdates, setLiveUpdates] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [systemStats, setSystemStats] = useState({
    activeSessions: 0,
    totalSessions: 0,
    activeTpas: 0,
    totalTpas: 0
  });

  // Handle session updates from SSE
  const handleSessionsUpdate = (sessions: DebugSessionInfo[], stats: any) => {
    setSessions(sessions);
    setSystemStats(stats);
    setIsLoading(false);
  };

  // Handle individual events from SSE
  const handleEvent = (event: any) => {
    switch (event.type) {
      case 'SESSION_UPDATE':
        setSessions(prevSessions => {
          const updatedSessions = [...prevSessions];
          const sessionIndex = updatedSessions.findIndex(s => s.sessionId === event.sessionId);
          if (sessionIndex !== -1) {
            updatedSessions[sessionIndex] = {
              ...updatedSessions[sessionIndex],
              ...event.data
            };
          }
          return updatedSessions;
        });
        break;
      case 'SESSION_CONNECTED':
        // Refresh sessions to get the new one
        fetchSessions().then(data => {
          setSessions(data.sessions);
          setSystemStats(data.stats);
        });
        break;
      case 'SESSION_DISCONNECTED':
        setSessions(prevSessions => {
          const updatedSessions = [...prevSessions];
          const sessionIndex = updatedSessions.findIndex(s => s.sessionId === event.sessionId);
          if (sessionIndex !== -1) {
            updatedSessions[sessionIndex] = {
              ...updatedSessions[sessionIndex],
              disconnectedAt: event.timestamp
            };
          }
          return updatedSessions;
        });
        break;
      case 'SYSTEM_STATS_UPDATE':
        setSystemStats(event.stats);
        break;
    }
  };

  // Initial data fetch
  useEffect(() => {
    const loadSessions = async () => {
      try {
        const data = await fetchSessions();
        setSessions(data.sessions);
        setSystemStats(data.stats);
        setIsLoading(false);
      } catch (error) {
        console.error('Error fetching sessions:', error);
        setIsLoading(false);
      }
    };

    loadSessions();
  }, []);

  // Filter sessions based on search term
  const filteredSessions = sessions.filter(session => 
    session.sessionId.includes(searchTerm) || 
    session.userId.includes(searchTerm) ||
    (session.activeAppSessions && session.activeAppSessions.some(tpa => tpa && tpa.includes(searchTerm)))
  );

  // Get selected session
  const selectedSession = sessions.find(s => s.sessionId === selectedSessionId) || null;

  // Add logging to inspect session serialization
  useEffect(() => {
    if (selectedSession) {
      console.log('Selected Session Data:', {
        ...selectedSession,
        // Explicitly log nested objects
        transcript: selectedSession.transcript,
        subscriptionManager: selectedSession.subscriptionManager,
        displayManager: selectedSession.displayManager,
        dashboardManager: selectedSession.dashboardManager,
        appConnections: selectedSession.appConnections,
        audioBuffer: selectedSession.audioBuffer,
        lc3Service: selectedSession.lc3Service
      });
    }
  }, [selectedSession]);

  // Toggle a node in the state tree
  const toggleNode = (path: string) => {
    setExpandedNodes(prev => ({
      ...prev,
      [path]: !prev[path]
    }));
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SSE Connection */}
      <DebuggerEvents
        onEvent={handleEvent}
        onSessionsUpdate={handleSessionsUpdate}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div className="w-60 bg-white border-r border-gray-200">
          <div className="p-4 border-b border-gray-200">
            <a href="#" className="flex items-center gap-2 text-gray-700 hover:text-gray-900 mb-6">
              <Home size={18} />
              <span>Dashboard</span>
            </a>
            <h2 className="font-medium text-lg mb-2">Debugger</h2>
          </div>
          <div className="p-4">
            <div className="mb-4">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search sessions..."
                  className="w-full p-2 pl-8 border rounded text-sm"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                />
                <Search className="absolute left-2 top-2.5 text-gray-400" size={16} />
                {searchTerm && (
                  <button className="absolute right-2 top-2.5 text-gray-400" onClick={() => setSearchTerm('')}>
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>
            
            <SessionList 
              sessions={filteredSessions}
              selectedSessionId={selectedSessionId}
              setSelectedSessionId={setSelectedSessionId}
              isLoading={isLoading}
              searchTerm={searchTerm}
            />
          </div>
        </div>

        {/* Main Content */}
        <div className="flex-1 overflow-y-auto">
          {/* System Overview */}
          <SystemOverview stats={systemStats} />

          {/* Session Inspector */}
          <div className="p-6">
            {selectedSession ? (
              <SessionInspector 
                session={selectedSession}
                expandedNodes={expandedNodes}
                toggleNode={toggleNode}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                <div className="text-center">
                  <AlertCircle size={48} className="mx-auto mb-2" />
                  <p>No session selected</p>
                  <p className="text-sm text-gray-500">Select a session from the sidebar to view details</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
} 