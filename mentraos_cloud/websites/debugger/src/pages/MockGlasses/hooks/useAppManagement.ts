import { GlassesToCloudMessage, AppI } from '@augmentos/sdk';
import { useState, useEffect, useCallback } from 'react';

interface ActiveApp {
  packageName: string;
  name: string;
  tpaSessionId?: string;
  status: 'starting' | 'active' | 'error';
}

export const useAppManagement = (
  sessionId: string | null,
  sendMessage: (message: GlassesToCloudMessage) => void
) => {
  const [availableApps, setAvailableApps] = useState<AppI[]>([]);
  const [activeApps, setActiveApps] = useState<ActiveApp[]>([]);

  // Fetch available apps on mount and when sessionId changes
  useEffect(() => {
    const fetchApps = async () => {
      try {
        const response = await fetch(`http://localhost:8002/apps`);
        const apps = await response.json();
        setAvailableApps(apps);
      } catch (error) {
        console.error('Error fetching apps:', error);
      }
    };
    fetchApps();
  }, [sessionId]);

  const startApp = useCallback(async (packageName: string) => {
    if (!sessionId) return;

    try {
      setActiveApps(prev => [
        ...prev,
        {
          packageName,
          name: availableApps.find(a => a.packageName === packageName)?.name || packageName,
          status: 'starting'
        }
      ]);

      console.log(`Starting app ${packageName}... sessionId: ${sessionId}`);
      const response = await fetch(`http://localhost:8002/apps/${packageName}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ sessionId })
      });

      const result = await response.json();

      if (response.ok) {
        setActiveApps(prev =>
          prev.map(app =>
            app.packageName === packageName
              ? { ...app, status: 'active', tpaSessionId: result.tpaSessionId }
              : app
          )
        );

        // Notify WebSocket about app start
        sendMessage({ type: 'start_app', packageName });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error(`Error starting app ${packageName}:`, error);
      setActiveApps(prev =>
        prev.map(app =>
          app.packageName === packageName ? { ...app, status: 'error' } : app
        )
      );
    }
  }, [sessionId, availableApps, sendMessage]);

  const stopApp = useCallback(async (packageName: string) => {
    if (!sessionId) return;

    try {
      // Notify WebSocket about app stop
      sendMessage({
        type: 'stop_app',
        packageName,
        sessionId
      });

      setActiveApps(prev => prev.filter(app => app.packageName !== packageName));
    } catch (error) {
      console.error(`Error stopping app ${packageName}:`, error);
    }
  }, [sessionId, sendMessage]);

  return {
    availableApps,
    activeApps,
    startApp,
    stopApp
  };
};