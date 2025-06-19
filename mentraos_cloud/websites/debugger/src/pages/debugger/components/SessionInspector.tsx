/** @jsxImportSource react */
import type { FC } from 'react';
import { Eye, PowerOff, RefreshCw } from 'lucide-react';
import { StateTreeNode } from './StateTreeNode';

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

interface SessionInspectorProps {
  session: DebugSessionInfo;
  expandedNodes: Record<string, boolean>;
  toggleNode: (path: string) => void;
}

export const SessionInspector: FC<SessionInspectorProps> = ({ session, expandedNodes, toggleNode }) => {
  // Safe check to see if a session is active
  const isSessionActive = (session: DebugSessionInfo) => {
    return session && !session.disconnectedAt;
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200">
        <h2 className="text-lg font-medium mb-4 flex items-center gap-2">
          Session Information
          <span className={`px-2 py-0.5 text-xs rounded-full ${isSessionActive(session) ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>
            {isSessionActive(session) ? 'active' : 'disconnected'}
          </span>
        </h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-gray-500">Session ID</div>
            <div className="font-medium">{session.sessionId}</div>
          </div>
          <div>
            <div className="text-sm text-gray-500">User ID</div>
            <div className="font-medium">{session.userId}</div>
          </div>
          <div>
            <div className="text-sm text-gray-500">Started</div>
            <div className="font-medium">{new Date(session.startTime).toLocaleString()}</div>
          </div>
          <div>
            <div className="text-sm text-gray-500">Status</div>
            <div className="font-medium">
              {isSessionActive(session) ? 'Connected' : `Disconnected at ${new Date(session.disconnectedAt!).toLocaleString()}`}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <div className="col-span-1">
          {/* State Tree */}
          <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200 mb-6">
            <h2 className="text-lg font-medium mb-4">Session State Tree</h2>
            <div className="border rounded border-gray-200 overflow-x-auto">
              <StateTreeNode 
                label="Session"
                path="root"
                data={session}
                expandedNodes={expandedNodes}
                toggleNode={toggleNode}
                depth={0}
              />
            </div>
          </div>

          {/* Display State */}
          <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200 mb-6">
            <h2 className="text-lg font-medium mb-4">Current Display</h2>
            {!session.displayManager?.activeDisplay ? (
              <div className="text-gray-500 italic">No active display</div>
            ) : (
              <div className="border rounded p-4 border-gray-200">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-medium">{session.displayManager.activeDisplay.displayRequest.packageName}</div>
                    <div className="text-sm text-gray-500">Layout: {session.displayManager.activeDisplay.displayRequest.layout.layoutType}</div>
                    <div className="text-sm text-gray-500">
                      Time: {new Date(session.displayManager.activeDisplay.startedAt).toLocaleTimeString()}
                    </div>
                  </div>
                  <div className="bg-gray-50 p-4 rounded border border-gray-200 text-sm">
                    {session.displayManager.activeDisplay.displayRequest.layout.layoutType === 'text_wall' && (
                      <div>{session.displayManager.activeDisplay.displayRequest.layout.text}</div>
                    )}
                    {session.displayManager.activeDisplay.displayRequest.layout.layoutType === 'reference_card' && (
                      <div>
                        <div className="font-medium">{session.displayManager.activeDisplay.displayRequest.layout.title}</div>
                        <div>{session.displayManager.activeDisplay.displayRequest.layout.text}</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            
            <div className="mt-4">
              <div className="flex justify-between items-center mb-2">
                <div className="text-sm font-medium">Display History</div>
                <button className="text-xs text-gray-800 hover:underline">View All</button>
              </div>
              
              {!session.displayManager?.displayHistory?.length ? (
                <div className="text-gray-500 italic text-sm">No display history</div>
              ) : (
                <div className="space-y-2 max-h-32 overflow-y-auto border rounded border-gray-200 p-2">
                  {session.displayManager.displayHistory.slice(0, 3).map((display, idx) => (
                    <div key={idx} className="border-b last:border-b-0 pb-2 last:pb-0 text-sm">
                      <div className="text-xs text-gray-500">
                        {new Date(display.startedAt).toLocaleTimeString()} - {display.displayRequest.packageName}
                      </div>
                      <div className="truncate">
                        {display.displayRequest.layout.layoutType === 'text_wall' && display.displayRequest.layout.text}
                        {display.displayRequest.layout.layoutType === 'reference_card' && 
                          `${display.displayRequest.layout.title}: ${display.displayRequest.layout.text}`
                        }
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          
          {/* Audio & Transcription State */}
          <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200 mb-6">
            <h2 className="text-lg font-medium mb-4">Audio & Transcription</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium mb-1">Transcription Status</div>
                <div className={`flex items-center ${session.isTranscribing ? 'text-green-600' : 'text-gray-500'}`}>
                  <div className={`w-2 h-2 rounded-full mr-1 ${session.isTranscribing ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                  {session.isTranscribing ? 'Active' : 'Inactive'}
                </div>
                
                <div className="text-sm font-medium mt-3 mb-1">Last Audio</div>
                <div className="text-sm">
                  {session.lastAudioTimestamp ? (
                    <>
                      {new Date(session.lastAudioTimestamp).toLocaleTimeString()}
                      <span className="text-xs text-gray-500 ml-1">
                        ({Math.round((Date.now() - session.lastAudioTimestamp) / 1000)}s ago)
                      </span>
                    </>
                  ) : (
                    <span className="text-gray-500 italic">No audio received</span>
                  )}
                </div>
                
                <div className="text-sm font-medium mt-3 mb-1">LC3 Service</div>
                <div className="text-sm">
                  {session.lc3Service ? (
                    <span className="text-green-600">Initialized</span>
                  ) : (
                    <span className="text-red-600">Not available</span>
                  )}
                </div>
              </div>
              
              <div>
                <div className="text-sm font-medium mb-1">Active Streams</div>
                {!session.transcriptionStreams || Object.keys(session.transcriptionStreams).length === 0 ? (
                  <div className="text-gray-500 italic text-sm">No active streams</div>
                ) : (
                  <div className="space-y-1">
                    {Object.entries(session.transcriptionStreams).map(([lang, stream], idx) => (
                      <div key={idx} className="text-sm flex items-center">
                        <div className="w-2 h-2 rounded-full bg-green-500 mr-1"></div>
                        {lang} ({stream.status})
                      </div>
                    ))}
                  </div>
                )}
                
                <div className="text-sm font-medium mt-3 mb-1">Audio Buffer</div>
                <div className="text-sm">
                  {session.audioBuffer ? (
                    <>
                      Last Sequence: {session.audioBuffer.lastProcessedSequence}
                      <br />
                      Status: {session.audioBuffer.processingInProgress ? 'Processing' : 'Idle'}
                    </>
                  ) : (
                    <span className="text-gray-500 italic">No buffer info</span>
                  )}
                </div>
              </div>
            </div>
            
            <div className="mt-4">
              <div className="text-sm font-medium mb-2">Recent Transcriptions</div>
              {!session.transcript?.segments?.length ? (
                <div className="text-gray-500 italic text-sm">No transcriptions</div>
              ) : (
                <div className="space-y-1 max-h-32 overflow-y-auto border rounded border-gray-200 p-3">
                  {session.transcript.segments.slice(0, 5).map((segment, idx) => (
                    <div key={idx} className="text-sm">
                      <span className="text-xs text-gray-500">
                        {new Date(segment.timestamp).toLocaleTimeString()}:
                      </span>
                      {" "}{segment.text}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Recent Events - Now full width */}
          <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200 mb-6">
            <h2 className="text-lg font-medium mb-4">Recent Events</h2>
            {!session.recentEvents?.length ? (
              <div className="text-gray-500 italic">No recent events</div>
            ) : (
              <div className="space-y-2">
                {session.recentEvents.map((event, idx) => (
                  <div key={idx} className="border-b last:border-b-0 pb-2 last:pb-0">
                    <div className="text-sm text-gray-500">{new Date(event.time).toLocaleTimeString()}</div>
                    <div className="text-sm">{event.description}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Active TPAs - At the bottom */}
      <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200">
        <h2 className="text-lg font-medium mb-4">Active TPAs</h2>
        {!session.activeAppSessions || session.activeAppSessions.length === 0 ? (
          <div className="text-gray-500 italic">No active TPAs</div>
        ) : (
          <div className="divide-y divide-gray-200">
            {session.activeAppSessions.map((tpaName, index) => {
              const subscriptions = session.subscriptionManager?.subscriptions?.[tpaName] || [];
              const connectionState = session.appConnections?.[tpaName]?.readyState;
              // WebSocket readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
              const connectionStatus = connectionState === 1 ? 'connected' : 
                                      connectionState === 0 ? 'connecting' :
                                      connectionState === 2 ? 'closing' : 'disconnected';
              const isLoading = session.loadingApps && session.loadingApps.has && session.loadingApps.has(tpaName);
              
              return (
                <div key={`${tpaName}-${index}`} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${
                        connectionState === 1 ? 'bg-green-500' : 
                        connectionState === 0 ? 'bg-yellow-500' :
                        'bg-red-500'
                      }`}></div>
                      <span className="font-medium">{tpaName}</span>
                      <span className={`text-sm ${
                        connectionState === 1 ? 'text-green-600' : 
                        connectionState === 0 ? 'text-yellow-600' :
                        'text-red-600'
                      }`}>
                        ({connectionStatus})
                      </span>
                      {isLoading && (
                        <div className="text-sm text-yellow-600 flex items-center">
                          <RefreshCw size={12} className="animate-spin mr-1" />
                          Loading...
                        </div>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-4">
                      <div className="text-sm">
                        <span className="text-gray-500">Subscriptions: </span>
                        {subscriptions.length === 0 ? (
                          <span className="italic text-gray-400">None</span>
                        ) : (
                          <span className="space-x-1">
                            {subscriptions.map((sub, subIndex) => (
                              <span key={`${sub}-${subIndex}`} className="bg-gray-100 text-gray-800 px-2 py-0.5 rounded">
                                {sub}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}; 