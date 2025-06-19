import React from 'react';

interface SessionHeaderProps {
  isConnected: boolean;
  onStart: () => void;
  onStop: () => void;
}

export const SessionHeader: React.FC<SessionHeaderProps> = ({
  isConnected,
  onStart,
  onStop,
}) => {
  return (
    <div className="flex justify-between items-center mb-4">
      <div className="flex items-center gap-4">
        <h2 className="font-bold text-green-600">Mentra.Glass Dev</h2>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${
            isConnected ? 'bg-green-500' : 'bg-gray-500'
          }`} />
          <span className="text-sm text-gray-400">
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={isConnected ? onStop : onStart}
          className={`px-4 py-2 rounded ${
            isConnected 
              ? 'bg-red-500 hover:bg-red-600' 
              : 'bg-green-600 hover:bg-green-700'
          } text-white transition-colors`}
        >
          {isConnected ? 'Stop Session' : 'Start Session'}
        </button>
      </div>
    </div>
  );
};