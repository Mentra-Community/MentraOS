import { AppI } from '@mentra/types';
import React from 'react';

interface AppGridProps {
  apps: AppI[];
  activeApps: Array<{
    packageName: string;
    status: 'starting' | 'active' | 'error';
  }>;
  onAppStart: (packageName: string) => void;
  onAppStop: (packageName: string) => void;
}

export const AppGrid: React.FC<AppGridProps> = ({
  apps,
  activeApps,
  onAppStart,
  onAppStop,
}) => {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 p-4 bg-white/5 rounded-lg mt-auto">
      {apps.map(app => {
        const activeApp = activeApps.find(a => a.packageName === app.packageName);
        return (
          <AppCard
            key={app.packageName}
            app={app}
            status={activeApp?.status}
            onStart={() => onAppStart(app.packageName)}
            onStop={() => onAppStop(app.packageName)}
          />
        );
      })}
    </div>
  );
};

// AppCard Component
interface AppCardProps {
  app: AppI;
  status?: 'starting' | 'active' | 'error';
  onStart: () => void;
  onStop: () => void;
}

export const AppCard: React.FC<AppCardProps> = ({
  app,
  status,
  onStart,
  onStop,
}) => {
  const isActive = !!status;

  return (
    <div
      className={`p-3 rounded-lg border ${
        isActive
          ? 'border-green-500 bg-gray-800'
          : 'border-gray-700 hover:border-gray-500'
      } cursor-pointer transition-colors`}
      onClick={() => {
        if (isActive) {
          onStop();
        } else {
          onStart();
        }
      }}
    >
      <div className="flex items-start gap-3">
        <img
          src={app.logoURL}
          alt={app.name}
          className="w-8 h-8 rounded"
        />
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">{app.name}</h3>
            {status && (
              <div className={`w-2 h-2 rounded-full ${
                status === 'active'
                  ? 'bg-green-400'
                  : status === 'error'
                    ? 'bg-red-400'
                    : 'bg-gray-400 animate-pulse'
              }`} />
            )}
          </div>
          {app.description && (
            <p className="text-xs text-gray-400 mt-1">{app.description}</p>
          )}
        </div>
      </div>
    </div>
  );
};