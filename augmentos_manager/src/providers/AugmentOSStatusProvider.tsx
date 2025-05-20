import React, { createContext, useContext, useState, ReactNode, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { AugmentOSParser, AugmentOSMainStatus } from '../AugmentOSStatusParser.tsx';
import { INTENSE_LOGGING, MOCK_CONNECTION } from '../consts.tsx';
import GlobalEventEmitter from "../logic/GlobalEventEmitter.tsx";
import BackendServerComms from '../backend_comms/BackendServerComms';
import { useAuth } from '../AuthContext';
import coreCommunicator from '../bridge/CoreCommunicator';

interface AugmentOSStatusContextType {
    status: AugmentOSMainStatus;
    initializeCoreConnection: () => void;
    refreshStatus: (data: any) => void;
    screenMirrorItems: { id: string; name: string }[]
    getCoreToken: () => string | null;
}

const AugmentOSStatusContext = createContext<AugmentOSStatusContextType | undefined>(undefined);

export const StatusProvider = ({ children }: { children: ReactNode }) => {
    const [status, setStatus] = useState<AugmentOSMainStatus>(() => {
        return AugmentOSParser.parseStatus({});
    });
    const [isInitialized, setIsInitialized] = useState(false);
    const [screenMirrorItems, setScreenMirrorItems] = useState<{ id: string; name: string }[]>([]);
    
    const refreshStatus = useCallback((data: any) => {
        if (!(data && 'status' in data)) {return;}

        const parsedStatus = AugmentOSParser.parseStatus(data);

        const forceUpdate = parsedStatus.force_update;

        if (INTENSE_LOGGING)
            console.log('Parsed status:', parsedStatus);
        
        setStatus(parsedStatus);
    }, []);

    // Add user as a dependency to trigger re-initialization after login
    const { user } = useAuth();

    useEffect(() => {
        // Force a complete reset of status during sign-out/sign-in transition
        if (!user) {
            console.log('User signed out, resetting status');
            setStatus(AugmentOSParser.defaultStatus);
            return;
        }

        if (!isInitialized) return;

        // Log the status provider re-initialization for debugging
        console.log('STATUS PROVIDER: Initializing event listeners for user:', user?.email);

        const handleStatusUpdateReceived = (data: any) => {
            if (INTENSE_LOGGING)
                console.log('Handling received data.. refreshing status..');
            refreshStatus(data);
        };

        const handleDeviceDisconnected = () => {
            console.log('Core disconnected');
            setStatus(AugmentOSParser.defaultStatus);
        };

        if (!MOCK_CONNECTION) {
            // First, ensure we're not double-registering by removing any existing listeners
            coreCommunicator.removeAllListeners('statusUpdateReceived');
            coreCommunicator.removeAllListeners('dataReceived');
            GlobalEventEmitter.removeAllListeners('STATUS_PARSE_ERROR');
            
            // Register fresh listeners
            coreCommunicator.on('statusUpdateReceived', handleStatusUpdateReceived);
            GlobalEventEmitter.on('STATUS_PARSE_ERROR', handleDeviceDisconnected);
            
            console.log('STATUS PROVIDER: Event listeners registered successfully');
            
            // Force a status request to update UI immediately
            setTimeout(() => {
                coreCommunicator.sendRequestStatus();
            }, 1000);
        }

        return () => {
            if (!MOCK_CONNECTION) {
                coreCommunicator.removeListener('statusUpdateReceived', handleStatusUpdateReceived);
                GlobalEventEmitter.removeListener('STATUS_PARSE_ERROR', handleDeviceDisconnected);
                console.log('STATUS PROVIDER: Event listeners cleaned up');
            }
        };
    }, [refreshStatus, isInitialized, user]); // Added user dependency

    // Initialize the Core communication
    const initializeCoreConnection = React.useCallback(() => {
        console.log("Initializing Core communication");
        coreCommunicator.initialize();
        setIsInitialized(true);
    }, []);
    
    // Helper to get coreToken (directly returns from BackendServerComms)
    const getCoreToken = useCallback(() => {
        return BackendServerComms.getInstance().getCoreToken();
    }, []);

    return (
        <AugmentOSStatusContext.Provider value={{ 
            initializeCoreConnection,
            screenMirrorItems, 
            status, 
            refreshStatus,
            getCoreToken
        }}>
            {children}
        </AugmentOSStatusContext.Provider>
    );
};

export const useStatus = () => {
    const context = useContext(AugmentOSStatusContext);
    if (!context) {
        throw new Error('useStatus must be used within a StatusProvider');
    }
    return context;
};