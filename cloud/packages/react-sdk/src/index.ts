// react-sdk/src/index.ts
export { MentraAuthProvider } from './AuthProvider';
export { useMentraAuth } from './useMentraAuth';
export { useMentraBridge, share, openUrl, copyToClipboard, download, isInMentraOS, getMentraOSPlatform, hasCapability, getCapsuleMenuRect, useCapsuleMenu } from './useMentraBridge';
export type { AuthState } from './lib/authCore'; // Expose AuthState if useful
export type { CapsuleMenuRect } from './useMentraBridge';