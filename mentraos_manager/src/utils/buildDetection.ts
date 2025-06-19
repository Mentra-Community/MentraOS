import { Platform } from 'react-native';
import Constants from 'expo-constants';

/**
 * Detects if the current build allows developer features.
 * Returns true for:
 * - All Android builds (Google Play doesn't restrict dev features)
 * - iOS development builds (__DEV__ === true)
 * - iOS TestFlight builds
 * 
 * Returns false for:
 * - iOS App Store production builds
 */
export const isDeveloperBuildOrTestflight = (): boolean => {
  // Android: Always allow developer features
  if (Platform.OS === 'android') {
    return true;
  }
  
  // iOS Development: Allow if __DEV__ is true
  if (__DEV__) {
    return true;
  }
  
  // iOS Release builds: Check if it's TestFlight vs App Store
  // Method 1: Check if app was installed via TestFlight using Expo Constants
  if (Constants.appOwnership === 'expo') {
    // Expo Go - treat as development
    return true;
  }
  
  try {
    // Method 2: Check EAS build profile
    // Based on your eas.json:
    // - development/preview profiles use "distribution": "internal" (TestFlight)
    // - production profile has no distribution set (App Store)
    const easBuildProfile = Constants.expoConfig?.extra?.eas?.build?.profile;
    const buildId = Constants.expoConfig?.extra?.eas?.build?.id;
    
    // If we have EAS build info, check the profile
    if (easBuildProfile) {
      // development, preview, preview:device profiles should allow dev features
      const allowedProfiles = ['development', 'development:device', 'preview', 'preview:device'];
      if (allowedProfiles.includes(easBuildProfile)) {
        return true;
      }
      
      // If it's 'production' profile, it's App Store
      if (easBuildProfile === 'production') {
        return false;
      }
    }
    
    // Method 3: Check for any EAS build ID (indicates internal distribution)
    if (buildId) {
      // If we have a build ID but no profile info, assume it's TestFlight
      return true;
    }
    
    // Method 4: Check build environment
    const releaseChannel = Constants.expoConfig?.releaseChannel || Constants.manifest?.releaseChannel;
    if (releaseChannel && releaseChannel !== 'default') {
      // Custom release channel typically indicates TestFlight
      return true;
    }
    
    // Fallback: If we can't determine, assume App Store for safety
    return false;
    
  } catch (error) {
    console.log('Build detection error:', error);
    // If all detection methods fail, assume App Store production
    return false;
  }
};

/**
 * Returns true if this is an App Store production build
 * (inverse of isDeveloperBuildOrTestflight for iOS)
 */
export const isAppStoreProductionBuild = (): boolean => {
  if (Platform.OS === 'android') {
    return false; // Android builds don't need this restriction
  }
  
  return !isDeveloperBuildOrTestflight();
};

/**
 * Gets a human-readable description of the current build type
 */
export const getBuildTypeDescription = (): string => {
  if (Platform.OS === 'android') {
    return __DEV__ ? 'Android Development' : 'Android Production';
  }
  
  if (__DEV__) {
    return 'iOS Development';
  }
  
  // For iOS release builds, try to determine if TestFlight or App Store
  try {
    const easBuildProfile = Constants.expoConfig?.extra?.eas?.build?.profile;
    if (easBuildProfile) {
      switch (easBuildProfile) {
        case 'development':
        case 'development:device':
          return 'iOS Development (EAS)';
        case 'preview':
        case 'preview:device':
          return 'iOS TestFlight (Preview)';
        case 'production':
          return 'iOS App Store';
        default:
          return `iOS Release (${easBuildProfile})`;
      }
    }
  } catch {
    // Fallback to basic detection
  }
  
  return isDeveloperBuildOrTestflight() ? 'iOS TestFlight' : 'iOS App Store';
};