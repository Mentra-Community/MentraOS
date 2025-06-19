// src/pages/MockGlasses/MockGlasses.tsx

import React from 'react';
import { SessionHeader } from './components/SessionHeader';
import { DisplayArea } from './components/DisplayArea';
import { AppGrid } from './components/AppGrid';
import { AudioManager } from './components/AudioManager';
import { useWebSocket } from './hooks/useWebSocket';
import { useAppManagement } from './hooks/useAppManagement';

const MockGlasses: React.FC = () => {
  const {
    isConnected,
    sessionId,
    currentLayout,
    connect,
    disconnect,
    sendMessage,
    websocket
  } = useWebSocket();

  const {
    availableApps,
    activeApps,
    startApp,
    stopApp
  } = useAppManagement(sessionId, sendMessage);

  return (
    <div className="p-4 w-screen h-screen bg-[#121212] text-white flex flex-col">
      <SessionHeader 
        isConnected={isConnected}
        onStart={connect}
        onStop={disconnect}
      />

      <AudioManager 
        isRecording={isConnected}
        sessionId={sessionId}
        websocket={websocket}
      />

      <DisplayArea layout={currentLayout} />

      {sessionId && (
        <p className="text-xs text-gray-400 text-center mb-4">
          Session ID: {sessionId}
        </p>
      )}

      {activeApps.length > 0 && (
        <div className="flex gap-2 justify-center mb-4">
          {activeApps.map(app => (
            <div
              key={app.packageName}
              className={`px-3 py-1 rounded-full flex items-center gap-2 ${
                app.status === 'active'
                  ? 'bg-green-900'
                  : app.status === 'error'
                    ? 'bg-red-900'
                    : 'bg-gray-800'
              }`}
            >
              <div className={`w-2 h-2 rounded-full ${
                app.status === 'active'
                  ? 'bg-green-400'
                  : app.status === 'error'
                    ? 'bg-red-400'
                    : 'bg-gray-400 animate-pulse'
              }`} />
              <span>{app.name}</span>
            </div>
          ))}
        </div>
      )}

      {isConnected && (
        <AppGrid
          apps={availableApps}
          activeApps={activeApps}
          onAppStart={startApp}
          onAppStop={stopApp}
        />
      )}
    </div>
  );
};

export default MockGlasses;