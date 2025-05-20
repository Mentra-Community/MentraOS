import { RefreshCw } from 'lucide-react';

interface DebugSessionInfo {
  sessionId: string;
  userId: string;
  startTime: string;
  disconnectedAt: string | null;
  activeAppSessions: string[];
}

interface SessionListProps {
  sessions: DebugSessionInfo[];
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string) => void;
  isLoading: boolean;
  searchTerm: string;
}

export function SessionList({ 
  sessions, 
  selectedSessionId, 
  setSelectedSessionId, 
  isLoading,
  searchTerm 
}: SessionListProps) {
  // Safe check to see if a session is active
  const isSessionActive = (session: DebugSessionInfo) => {
    return session && !session.disconnectedAt;
  };

  // Safe array check
  const safeArrayLength = (arr: any[] | undefined) => {
    return Array.isArray(arr) ? arr.length : 0;
  };

  if (isLoading) {
    return (
      <div className="p-4 text-center text-gray-500">
        <RefreshCw className="animate-spin mx-auto mb-2" />
        <span className="text-sm">Loading sessions...</span>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500 text-sm">
        No sessions matching "{searchTerm}"
      </div>
    );
  }

  return (
    <ul className="space-y-1">
      {sessions.map(session => (
        <li 
          key={session.sessionId}
          className={`p-2 rounded cursor-pointer ${
            selectedSessionId === session.sessionId 
              ? 'bg-gray-100 border-l-2 border-gray-800' 
              : 'hover:bg-gray-50'
          }`}
          onClick={() => setSelectedSessionId(session.sessionId)}
        >
          <div className="font-medium flex items-center gap-2 text-sm">
            <div className={`w-2 h-2 rounded-full ${isSessionActive(session) ? 'bg-green-500' : 'bg-gray-400'}`}></div>
            {session.sessionId}
          </div>
          <div className="text-xs text-gray-500">User: {session.userId}</div>
          <div className="text-xs text-gray-500">
            {isSessionActive(session) ? 
              `Active TPAs: ${safeArrayLength(session.activeAppSessions)}` : 
              `Disconnected: ${new Date(session.disconnectedAt!).toLocaleTimeString()}`
            }
          </div>
        </li>
      ))}
    </ul>
  );
} 