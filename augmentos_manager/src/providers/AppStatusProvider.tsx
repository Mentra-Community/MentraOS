import React, {
  createContext,
  useContext,
  useState,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import BackendServerComms from '../backend_comms/BackendServerComms';
import {useAuth} from '../AuthContext';
import {useStatus} from './AugmentOSStatusProvider';
import GlobalEventEmitter from '../logic/GlobalEventEmitter';
import {
  checkFeaturePermissions,
  requestFeaturePermissions,
} from '../logic/PermissionsUtils';
import {PermissionFeatures} from '../logic/PermissionsUtils';

export interface TPAPermission {
  description: string;
  type:
    | 'MICROPHONE'
    | 'CAMERA'
    | 'CALENDAR'
    | 'NOTIFICATIONS'
    | 'LOCATION'
    | 'ALL';
  required?: boolean;
}

// Define the AppInterface based on AppI from SDK
export interface AppInterface {
  packageName: string;
  name: string;
  publicUrl: string;
  isSystemApp?: boolean;
  uninstallable?: boolean;
  webviewURL?: string;
  logoURL: string;
  tpaType: string;
  appStoreId?: string;
  developerId?: string;
  hashedEndpointSecret?: string;
  hashedApiKey?: string;
  description?: string;
  version?: string;
  settings?: Record<string, unknown>;
  isPublic?: boolean;
  appStoreStatus?: 'DEVELOPMENT' | 'SUBMITTED' | 'REJECTED' | 'PUBLISHED';
  developerProfile?: {
    company?: string;
    website?: string;
    contactEmail?: string;
    description?: string;
    logo?: string;
  };
  permissions: TPAPermission[];
  is_running?: boolean;
  is_foreground?: boolean;
}

interface AppStatusContextType {
  appStatus: AppInterface[];
  refreshAppStatus: () => Promise<void>;
  optimisticallyStartApp: (packageName: string) => void;
  optimisticallyStopApp: (packageName: string) => void;
  clearPendingOperation: (packageName: string) => void;
  isLoading: boolean;
  error: string | null;
  isSensingEnabled: boolean;
}

const AppStatusContext = createContext<AppStatusContextType | undefined>(
  undefined,
);

export const AppStatusProvider = ({children}: {children: ReactNode}) => {
  const [appStatus, setAppStatus] = useState<AppInterface[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {user} = useAuth();
  const {status} = useStatus();

  // Keep track of active operations to prevent race conditions
  const pendingOperations = useRef<{[packageName: string]: 'start' | 'stop'}>(
    {},
  );

  // Track when the last refresh was performed
  const lastRefreshTime = useRef<number>(0);

  const refreshAppStatus = useCallback(async () => {
    if (!user) {
      setAppStatus([]);
      return;
    }

    // Check if we have a core token in the status
    if (!status.core_info.core_token) {
      console.log('Waiting for core token before fetching apps');
      return;
    }

    setIsLoading(true);
    setError(null);

    // Record the time of this refresh attempt
    const refreshStartTime = Date.now();
    lastRefreshTime.current = refreshStartTime;

    try {
      // Store current running states before fetching
      const currentRunningStates: {[packageName: string]: boolean} = {};
      appStatus.forEach(app => {
        if (app.is_running) {
          currentRunningStates[app.packageName] = true;
        }
      });

      const appsData = await BackendServerComms.getInstance().getApps();

      // Only process this update if it's the most recent one
      if (refreshStartTime === lastRefreshTime.current) {
        // Merge existing running states with new data
        const updatedAppsData = appsData.map(app => {
          // Make a shallow copy of the app object
          const appCopy = {...app};

          // Check pending operations first
          const pendingOp = pendingOperations.current[app.packageName];
          if (pendingOp === 'start') {
            appCopy.is_running = true;
          } else if (pendingOp === 'stop') {
            appCopy.is_running = false;
          } else if (app.is_running !== undefined) {
            // If the server provided is_running status, use it
            appCopy.is_running = Boolean(app.is_running);
          } else if (currentRunningStates[app.packageName]) {
            // Fallback to our local state if server didn't provide is_running
            appCopy.is_running = true;
          } else {
            // Default to not running if no information is available
            appCopy.is_running = false;
          }

          return appCopy;
        });

        setAppStatus(updatedAppsData);
      }
    } catch (err) {
      console.error('Error fetching apps:', err);
      setError('Error fetching apps');
    } finally {
      setIsLoading(false);
    }
  }, [user, status]);

  // Optimistically update app status when starting an app
  const optimisticallyStartApp = useCallback((packageName: string) => {
    // Record that we have a pending start operation
    pendingOperations.current[packageName] = 'start';

    // Set a timeout to clear this operation after 10 seconds (in case callback never happens)
    setTimeout(() => {
      if (pendingOperations.current[packageName] === 'start') {
        delete pendingOperations.current[packageName];
      }
    }, 20000);

    setAppStatus(currentStatus => {
      // First update all apps' foreground status
      const updatedApps = currentStatus.map(app => ({
        ...app,
        is_foreground: app.packageName === packageName,
      }));

      // Then update the target app to be running
      return updatedApps.map(app =>
        app.packageName === packageName
          ? {...app, is_running: true, is_foreground: true}
          : app,
      );
    });
  }, []);

  // Optimistically update app status when stopping an app
  const optimisticallyStopApp = useCallback((packageName: string) => {
    // Record that we have a pending stop operation
    pendingOperations.current[packageName] = 'stop';

    // Set a timeout to clear this operation after 10 seconds
    setTimeout(() => {
      if (pendingOperations.current[packageName] === 'stop') {
        delete pendingOperations.current[packageName];
      }
    }, 10000);

    setAppStatus(currentStatus =>
      currentStatus.map(app =>
        app.packageName === packageName ? {...app, is_running: false} : app,
      ),
    );
  }, []);

  // When an app start/stop operation succeeds, clear the pending operation
  const clearPendingOperation = useCallback((packageName: string) => {
    delete pendingOperations.current[packageName];
  }, []);

  // Initial fetch and refresh on user change or status change
  useEffect(() => {
    refreshAppStatus();
  }, [user, status]);

  // Listen for app started/stopped events from CoreCommunicator
  useEffect(() => {
    const onAppStarted = (packageName: string) => {
      console.log('APP_STARTED_EVENT', packageName);
      optimisticallyStartApp(packageName);
    };
    const onAppStopped = (packageName: string) => {
      console.log('APP_STOPPED_EVENT', packageName);
      optimisticallyStopApp(packageName);
    };
    // @ts-ignore
    GlobalEventEmitter.on('APP_STARTED_EVENT', onAppStarted);
    // @ts-ignore
    GlobalEventEmitter.on('APP_STOPPED_EVENT', onAppStopped);
    return () => {
      // @ts-ignore
      GlobalEventEmitter.off('APP_STARTED_EVENT', onAppStarted);
      // @ts-ignore
      GlobalEventEmitter.off('APP_STOPPED_EVENT', onAppStopped);
    };
  }, [optimisticallyStartApp, optimisticallyStopApp]);

  return (
    <AppStatusContext.Provider
      value={{
        appStatus,
        refreshAppStatus,
        optimisticallyStartApp,
        optimisticallyStopApp,
        clearPendingOperation,
        isLoading,
        error,
        isSensingEnabled: status.core_info.sensing_enabled,
      }}>
      {children}
    </AppStatusContext.Provider>
  );
};

export const useAppStatus = () => {
  const context = useContext(AppStatusContext);
  if (!context) {
    throw new Error('useAppStatus must be used within an AppStatusProvider');
  }
  return context;
};
