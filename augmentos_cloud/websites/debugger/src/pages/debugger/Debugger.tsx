import { FC, useState, useEffect } from 'react';
import { Search } from 'lucide-react';
import { SystemOverview } from './components/SystemOverview';
import { SessionList } from './components/SessionList';
import { SessionInspector } from './components/SessionInspector';
import { fetchSessions } from '../api/debug/sessions';

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

export const Debugger: FC = () => {
  const [sessions, setSessions] = useState<DebugSessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const [systemStats, setSystemStats] = useState({
    activeSessions: 0,
    totalSessions: 0,
    activeTpas: 0,
    totalTpas: 0
  });

  // Fetch sessions data
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
    const interval = setInterval(loadSessions, 5000); // Refresh every 5 seconds

    return () => clearInterval(interval);
  }, []);

  // Filter sessions based on search term
  const filteredSessions = sessions.filter(session => 
    session.sessionId.toLowerCase().includes(searchTerm.toLowerCase()) ||
    session.userId.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Toggle node expansion in the state tree
  const toggleNode = (path: string) => {
    setExpandedNodes(prev => ({
      ...prev,
      [path]: !prev[path]
    }));
  };

  // Get the selected session
  const selectedSession = sessions.find(s => s.sessionId === selectedSessionId);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Debugger</h1>
          <p className="mt-1 text-sm text-gray-500">
            Monitor and debug active sessions and TPAs
          </p>
        </div>

        <SystemOverview stats={systemStats} />

        <div className="mt-8 grid grid-cols-12 gap-6">
          {/* Sessions List */}
          <div className="col-span-3">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="p-4 border-b border-gray-200">
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Search className="h-5 w-5 text-gray-400" />
                  </div>
                  <input
                    type="text"
                    className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                    placeholder="Search sessions..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
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

          {/* Session Inspector */}
          <div className="col-span-9">
            {selectedSession ? (
              <SessionInspector
                session={selectedSession}
                expandedNodes={expandedNodes}
                toggleNode={toggleNode}
              />
            ) : (
              <div className="bg-white rounded-lg shadow-sm p-8 border border-gray-200 text-center">
                <h3 className="text-lg font-medium text-gray-900">No Session Selected</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Select a session from the list to view its details
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}; 