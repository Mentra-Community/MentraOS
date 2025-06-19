/**
 * TPA Server Registration Model
 * 
 * This model tracks registered TPA servers and their connection details.
 * It allows for TPAs to automatically recover sessions when they restart.
 */
// TODO(isaiah): Pretty sure this entire file is not used anywhere, remove?
import { v4 as uuidv4 } from 'uuid';
import { logger } from '@augmentos/utils';
import { WebSocket } from 'ws';

/**
 * Represents a TPA server registration
 */
export interface TpaServerRegistration {
  // Unique identifier for this server registration
  registrationId: string;
  
  // TPA package name (e.g., "org.example.myapp")
  packageName: string;
  
  // API key used to authenticate the TPA
  apiKey: string;
  
  // URL of the TPA's webhook endpoint
  webhookUrl: string;
  
  // Server URLs this TPA can connect to (comma-separated if multiple environments)
  serverUrls: string[];
  
  // When this server was first registered
  registeredAt: Date;
  
  // When this server last connected or sent a heartbeat
  lastSeen: Date;
  
  // Whether this server registration is considered active
  isActive: boolean;
  
  // List of active session IDs associated with this server
  activeSessions: string[];
}

/**
 * Manages TPA server registrations
 */
export class TpaServerRegistry {
  private registrations: Map<string, TpaServerRegistration> = new Map();
  private packageNameToRegIds: Map<string, Set<string>> = new Map();
  private sessions: Map<string, Set<string>> = new Map(); // sessionId -> Set<registrationId>
  
  /**
   * Register a new TPA server
   * 
   * @param packageName - TPA package identifier
   * @param apiKey - API key for authentication
   * @param webhookUrl - TPA webhook URL
   * @param serverUrls - List of cloud servers this TPA can connect to (comma-separated)
   * @returns Registration ID
   */
  registerServer(
    packageName: string, 
    apiKey: string, 
    webhookUrl: string, 
    serverUrls: string[]
  ): string {
    // Generate a unique ID for this registration
    const registrationId = uuidv4();
    
    // Create registration object
    const registration: TpaServerRegistration = {
      registrationId,
      packageName,
      apiKey,
      webhookUrl,
      serverUrls,
      registeredAt: new Date(),
      lastSeen: new Date(),
      isActive: true,
      activeSessions: []
    };
    
    // Store in our maps
    this.registrations.set(registrationId, registration);
    
    // Add to packageName lookup
    if (!this.packageNameToRegIds.has(packageName)) {
      this.packageNameToRegIds.set(packageName, new Set());
    }
    this.packageNameToRegIds.get(packageName)!.add(registrationId);
    
    logger.info(`TPA server registered: ${packageName} (${registrationId})`);
    return registrationId;
  }
  
  /**
   * Update a TPA server registration's last seen timestamp
   * 
   * @param registrationId - TPA registration ID
   * @returns Updated registration or null if not found
   */
  updateHeartbeat(registrationId: string): TpaServerRegistration | null {
    const registration = this.registrations.get(registrationId);
    if (!registration) {
      return null;
    }
    
    registration.lastSeen = new Date();
    return registration;
  }
  
  /**
   * Get a TPA server registration by ID
   * 
   * @param registrationId - Registration ID
   * @returns Registration object or null if not found
   */
  getRegistration(registrationId: string): TpaServerRegistration | null {
    return this.registrations.get(registrationId) || null;
  }
  
  /**
   * Get all registrations for a specific TPA
   * 
   * @param packageName - TPA package name
   * @returns Array of registrations for this TPA
   */
  getRegistrationsByPackage(packageName: string): TpaServerRegistration[] {
    const regIds = this.packageNameToRegIds.get(packageName);
    if (!regIds) {
      return [];
    }
    
    return Array.from(regIds)
      .map(id => this.registrations.get(id))
      .filter(reg => reg !== undefined && reg.isActive) as TpaServerRegistration[];
  }
  
  /**
   * Associate a session with a registration
   * 
   * @param registrationId - TPA registration ID
   * @param sessionId - Session ID to associate (userSessionId-packageName)
   * @returns Success flag
   */
  addSessionToRegistration(registrationId: string, sessionId: string): boolean {
    const registration = this.registrations.get(registrationId);
    if (!registration) {
      return false;
    }
    
    // Add to registration's sessions
    if (!registration.activeSessions.includes(sessionId)) {
      registration.activeSessions.push(sessionId);
    }
    
    // Add to sessions map
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set());
    }
    this.sessions.get(sessionId)!.add(registrationId);
    
    logger.debug(`Session ${sessionId} added to TPA registration ${registrationId}`);
    return true;
  }
  
  /**
   * Remove a session from a registration
   * 
   * @param registrationId - TPA registration ID
   * @param sessionId - Session ID to remove
   * @returns Success flag
   */
  removeSessionFromRegistration(registrationId: string, sessionId: string): boolean {
    const registration = this.registrations.get(registrationId);
    if (!registration) {
      return false;
    }
    
    // Remove from registration's sessions
    registration.activeSessions = registration.activeSessions.filter(id => id !== sessionId);
    
    // Remove from sessions map
    const regIds = this.sessions.get(sessionId);
    if (regIds) {
      regIds.delete(registrationId);
      if (regIds.size === 0) {
        this.sessions.delete(sessionId);
      }
    }
    
    logger.debug(`Session ${sessionId} removed from TPA registration ${registrationId}`);
    return true;
  }
  
  /**
   * Get registrations associated with a session
   * 
   * @param sessionId - Session ID to look up
   * @returns Array of registrations
   */
  getRegistrationsBySession(sessionId: string): TpaServerRegistration[] {
    const regIds = this.sessions.get(sessionId);
    if (!regIds) {
      return [];
    }
    
    return Array.from(regIds)
      .map(id => this.registrations.get(id))
      .filter(reg => reg !== undefined && reg.isActive) as TpaServerRegistration[];
  }
  
  /**
   * Deactivate a TPA server registration
   * 
   * @param registrationId - Registration ID
   * @returns Success flag
   */
  deactivateRegistration(registrationId: string): boolean {
    const registration = this.registrations.get(registrationId);
    if (!registration) {
      return false;
    }
    
    registration.isActive = false;
    
    // Remove all session associations
    for (const sessionId of registration.activeSessions) {
      this.removeSessionFromRegistration(registrationId, sessionId);
    }
    
    logger.info(`TPA server deactivated: ${registration.packageName} (${registrationId})`);
    return true;
  }
  
  /**
   * Clean up stale registrations
   * 
   * @param maxAgeMs - Maximum age in milliseconds before considering a registration stale
   * @returns Number of deactivated registrations
   */
  cleanupStaleRegistrations(maxAgeMs: number = 1000 * 60 * 30): number {
    const now = new Date();
    let deactivatedCount = 0;
    
    for (const [registrationId, registration] of this.registrations.entries()) {
      if (!registration.isActive) continue;
      
      const lastSeenAge = now.getTime() - registration.lastSeen.getTime();
      if (lastSeenAge > maxAgeMs) {
        this.deactivateRegistration(registrationId);
        deactivatedCount++;
      }
    }
    
    return deactivatedCount;
  }
}

// Singleton instance
export const tpaServerRegistry = new TpaServerRegistry();
export default tpaServerRegistry;