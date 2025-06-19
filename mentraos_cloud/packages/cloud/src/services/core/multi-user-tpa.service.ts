/**
 * Multi-User TPA Service
 * 
 * Handles TPA-to-TPA communication by managing active user sessions for each TPA package
 * and routing messages between users with the same TPA active.
 */

import { WebSocket } from 'ws';
import { CloudToTpaMessageType, UserSession } from '@augmentos/sdk';
import { 
  TpaBroadcastMessage, 
  TpaDirectMessage, 
  TpaRoomJoin,
  TpaRoomLeave
} from '@augmentos/sdk/src/types/messages/tpa-to-cloud';
import {
  TpaMessageReceived,
  TpaUserJoined,
  TpaUserLeft,
  TpaRoomUpdated,
} from '@augmentos/sdk/src/types/messages/cloud-to-tpa';
import { logger as rootLogger } from '../logging';
import sessionService from '../session/session.service';

const logger = rootLogger.child({ service: 'multi-user-tpa.service' });

/**
 * Room configuration for group messaging
 */
interface RoomConfig {
  maxUsers?: number;
  isPrivate?: boolean;
  metadata?: any;
  createdBy: string;
  createdAt: Date;
}

/**
 * Active room data
 */
interface RoomData {
  id: string;
  packageName: string;
  config: RoomConfig;
  members: Set<string>; // User IDs
}

/**
 * Service to manage multi-user TPA sessions and communication
 */
export class MultiUserTpaService {
  /** Map of packageName -> Set of active user IDs */
  private activeTpaSessions = new Map<string, Set<string>>();
  
  /** Map of roomId -> Room data */
  private tpaRooms = new Map<string, RoomData>();
  
  /** Map of packageName -> Map of roomId -> Set of userIds */
  private packageRooms = new Map<string, Map<string, Set<string>>>();
  
  /** Message history for debugging (limited to last 100 messages per package) */
  private messageHistory = new Map<string, any[]>();
  
  /** Maximum messages to keep in history */
  private readonly MAX_HISTORY = 100;

  /**
   * Get all active users for a specific TPA package
   */
  getActiveTpaUsers(packageName: string): string[] {

    return Array.from(this.activeTpaSessions.get(packageName) || []);
  }

  /**
   * Broadcast message to all users with the same TPA active
   */
  async broadcastToTpaUsers(
    senderSession: UserSession, 
    message: TpaBroadcastMessage
  ): Promise<void> {
    const packageName = message.packageName;
    const activeUsers = this.getActiveTpaUsers(packageName);

    // console.log("432activeUsers", activeUsers)
    
    // logger.info({
    //   packageName,
    //   senderUserId: message.senderUserId,
    //   targetUserCount: activeUsers.length - 1, // Exclude sender
    // }, 'Broadcasting message to TPA users');

    let successCount = 0;
    
    for (const userId of activeUsers) {
      // console.log("userId")
      // console.log("senderSession.userId")
      // Skip sender
      if (userId === senderSession.userId) continue;
      
      const targetSession = sessionService.getSessionByUserId(userId);
      if (!targetSession) continue;

      // console.log("432432targetSession")
      
      const targetTpaConnection = targetSession.appWebsockets.get(packageName);
      if (!targetTpaConnection || targetTpaConnection.readyState !== WebSocket.OPEN) {
        continue;
      }

      // console.log("432432targetTpaConnection")

      try {
        const receivedMessage: TpaMessageReceived = {
          type: CloudToTpaMessageType.TPA_MESSAGE_RECEIVED,
          payload: message.payload,
          messageId: message.messageId,
          senderUserId: message.senderUserId,
          senderSessionId: message.sessionId,
          timestamp: message.timestamp
        };

        // console.log("@#$%^&*432432receivedMessage");

        targetTpaConnection.send(JSON.stringify(receivedMessage));
        successCount++;
      } catch (error) {
        logger.error({ error, userId, packageName }, 'Error sending broadcast message to user');
      }
    }

    // Store in message history
    this.addToMessageHistory(packageName, {
      messageId: message.messageId,
      senderUserId: message.senderUserId,
      payload: message.payload,
      timestamp: message.timestamp,
      deliveredToCount: successCount
    });

    logger.info({
      packageName,
      messageId: message.messageId,
      deliveredToCount: successCount
    }, 'Broadcast message delivery completed');
  }

  /**
   * Send direct message to specific user
   */
  async sendDirectMessage(
    senderSession: UserSession,
    message: TpaDirectMessage
  ): Promise<boolean> {
    logger.info({
      packageName: message.packageName,
      senderUserId: message.senderUserId,
      targetUserId: message.targetUserId,
      messageId: message.messageId
    }, 'Sending direct message');

    const targetSession = sessionService.getSessionByUserId(message.targetUserId);
    if (!targetSession) {
      logger.warn({
        targetUserId: message.targetUserId,
        messageId: message.messageId
      }, 'Target user session not found');
      return false;
    }

    const targetTpaConnection = targetSession.appWebsockets.get(message.packageName);
    if (!targetTpaConnection || targetTpaConnection.readyState !== WebSocket.OPEN) {
      logger.warn({
        targetUserId: message.targetUserId,
        packageName: message.packageName,
        messageId: message.messageId
      }, 'Target TPA connection not available');
      return false;
    }

    try {
      const receivedMessage: TpaMessageReceived = {
        type: CloudToTpaMessageType.TPA_MESSAGE_RECEIVED,
        payload: message.payload,
        messageId: message.messageId,
        senderUserId: message.senderUserId,
        senderSessionId: message.sessionId,
        timestamp: message.timestamp
      };

      targetTpaConnection.send(JSON.stringify(receivedMessage));

      // Store in message history
      this.addToMessageHistory(message.packageName, {
        messageId: message.messageId,
        senderUserId: message.senderUserId,
        targetUserId: message.targetUserId,
        payload: message.payload,
        timestamp: message.timestamp,
        delivered: true
      });

      logger.info({
        messageId: message.messageId,
        targetUserId: message.targetUserId
      }, 'Direct message delivered successfully');

      return true;
    } catch (error) {
      logger.error({
        error,
        messageId: message.messageId,
        targetUserId: message.targetUserId
      }, 'Error sending direct message');
      return false;
    }
  }

  /**
   * Handle user joining TPA session
   */
  addTpaUser(packageName: string, userId: string): void {
    if (!this.activeTpaSessions.has(packageName)) {
      this.activeTpaSessions.set(packageName, new Set());
    }
    
    const users = this.activeTpaSessions.get(packageName)!;
    const wasEmpty = users.size === 0;
    users.add(userId);
    
    logger.info({
      packageName,
      userId,
      totalActiveUsers: users.size,
      wasFirstUser: wasEmpty
    }, 'User joined TPA session');

    // Notify other users about the new user
    this.notifyUserJoined(packageName, userId);
  }

  /**
   * Handle user leaving TPA session
   */
  removeTpaUser(packageName: string, userId: string): void {
    const users = this.activeTpaSessions.get(packageName);
    if (users) {
      users.delete(userId);
      
      logger.info({
        packageName,
        userId,
        remainingUsers: users.size
      }, 'User left TPA session');

      // Clean up empty package sessions
      if (users.size === 0) {
        this.activeTpaSessions.delete(packageName);
        logger.info({ packageName }, 'Removed empty TPA package session');
      }

      // Remove user from all rooms for this package
      this.removeUserFromAllRooms(packageName, userId);
      
      // Notify other users about the user leaving
      this.notifyUserLeft(packageName, userId);
    }
  }

  /**
   * Handle room join request
   */
  async handleRoomJoin(
    senderSession: UserSession,
    message: TpaRoomJoin
  ): Promise<void> {
    const { packageName, roomId, roomConfig } = message;
    
    // Get or create room
    let roomData = this.tpaRooms.get(roomId);
    if (!roomData) {
      roomData = {
        id: roomId,
        packageName,
        config: {
          maxUsers: roomConfig?.maxUsers,
          isPrivate: roomConfig?.isPrivate || false,
          metadata: roomConfig?.metadata,
          createdBy: senderSession.userId,
          createdAt: new Date()
        },
        members: new Set()
      };
      this.tpaRooms.set(roomId, roomData);
      
      // Track room by package
      if (!this.packageRooms.has(packageName)) {
        this.packageRooms.set(packageName, new Map());
      }
      this.packageRooms.get(packageName)!.set(roomId, new Set());
    }

    // Check room capacity
    if (roomData.config.maxUsers && roomData.members.size >= roomData.config.maxUsers) {
      logger.warn({
        roomId,
        userId: senderSession.userId,
        currentMembers: roomData.members.size,
        maxUsers: roomData.config.maxUsers
      }, 'Room join rejected: room at capacity');
      return;
    }

    // Add user to room
    roomData.members.add(senderSession.userId);
    this.packageRooms.get(packageName)!.get(roomId)!.add(senderSession.userId);

    logger.info({
      roomId,
      userId: senderSession.userId,
      memberCount: roomData.members.size
    }, 'User joined room');

    // Notify room members about the new user
    this.notifyRoomUpdate(roomData, 'user_joined', senderSession.userId);
  }

  /**
   * Handle room leave request
   */
  async handleRoomLeave(
    senderSession: UserSession,
    message: TpaRoomLeave
  ): Promise<void> {
    const { roomId } = message;
    const roomData = this.tpaRooms.get(roomId);
    
    if (!roomData) {
      logger.warn({ roomId, userId: senderSession.userId }, 'Attempted to leave non-existent room');
      return;
    }

    roomData.members.delete(senderSession.userId);
    const packageRoomUsers = this.packageRooms.get(roomData.packageName)?.get(roomId);
    if (packageRoomUsers) {
      packageRoomUsers.delete(senderSession.userId);
    }

    logger.info({
      roomId,
      userId: senderSession.userId,
      remainingMembers: roomData.members.size
    }, 'User left room');

    // If room is empty, clean it up
    if (roomData.members.size === 0) {
      this.tpaRooms.delete(roomId);
      this.packageRooms.get(roomData.packageName)?.delete(roomId);
      logger.info({ roomId }, 'Removed empty room');
    } else {
      // Notify remaining members
      this.notifyRoomUpdate(roomData, 'user_left', senderSession.userId);
    }
  }

  /**
   * Remove user from all rooms for a package (cleanup on disconnect)
   */
  private removeUserFromAllRooms(packageName: string, userId: string): void {
    const packageRoomsMap = this.packageRooms.get(packageName);
    if (!packageRoomsMap) return;

    for (const [roomId, roomUsers] of packageRoomsMap.entries()) {
      if (roomUsers.has(userId)) {
        roomUsers.delete(userId);
        
        const roomData = this.tpaRooms.get(roomId);
        if (roomData) {
          roomData.members.delete(userId);
          
          if (roomData.members.size === 0) {
            // Clean up empty room
            this.tpaRooms.delete(roomId);
            packageRoomsMap.delete(roomId);
          } else {
            // Notify remaining members
            this.notifyRoomUpdate(roomData, 'user_left', userId);
          }
        }
      }
    }
  }

  /**
   * Notify users when someone joins the TPA
   */
  private notifyUserJoined(packageName: string, userId: string): void {
    const activeUsers = this.getActiveTpaUsers(packageName);
    
    for (const otherUserId of activeUsers) {
      if (otherUserId === userId) continue; // Don't notify the user who joined
      
      const userSession = sessionService.getSessionByUserId(otherUserId);
      if (!userSession) continue;
      
      const tpaConnection = userSession.appWebsockets.get(packageName);
      if (!tpaConnection || tpaConnection.readyState !== WebSocket.OPEN) continue;

      try {
        const joinMessage: TpaUserJoined = {
          type: CloudToTpaMessageType.TPA_USER_JOINED,
          userId,
          sessionId: sessionService.getSessionByUserId(userId)?.sessionId || 'unknown',
          joinedAt: new Date(),
          timestamp: new Date()
        };

        tpaConnection.send(JSON.stringify(joinMessage));
      } catch (error) {
        logger.error({ error, packageName, userId: otherUserId }, 'Error sending user joined notification');
      }
    }
  }

  /**
   * Notify users when someone leaves the TPA
   */
  private notifyUserLeft(packageName: string, userId: string): void {
    const activeUsers = this.getActiveTpaUsers(packageName);
    
    for (const otherUserId of activeUsers) {
      const userSession = sessionService.getSessionByUserId(otherUserId);
      if (!userSession) continue;
      
      const tpaConnection = userSession.appWebsockets.get(packageName);
      if (!tpaConnection || tpaConnection.readyState !== WebSocket.OPEN) continue;

      try {
        const leftMessage: TpaUserLeft = {
          type: CloudToTpaMessageType.TPA_USER_LEFT,
          userId,
          sessionId: 'unknown', // User already disconnected
          leftAt: new Date(),
          timestamp: new Date()
        };

        tpaConnection.send(JSON.stringify(leftMessage));
      } catch (error) {
        logger.error({ error, packageName, userId: otherUserId }, 'Error sending user left notification');
      }
    }
  }

  /**
   * Notify room members about room updates
   */
  private notifyRoomUpdate(roomData: RoomData, updateType: string, affectedUserId?: string): void {
    for (const userId of roomData.members) {
      const userSession = sessionService.getSessionByUserId(userId);
      if (!userSession) continue;
      
      const tpaConnection = userSession.appWebsockets.get(roomData.packageName);
      if (!tpaConnection || tpaConnection.readyState !== WebSocket.OPEN) continue;

      try {
        const updateMessage: TpaRoomUpdated = {
          type: CloudToTpaMessageType.TPA_ROOM_UPDATED,
          roomId: roomData.id,
          updateType: updateType as any,
          roomData: {
            memberCount: roomData.members.size,
            maxUsers: roomData.config.maxUsers,
            isPrivate: roomData.config.isPrivate,
            metadata: roomData.config.metadata
          },
          timestamp: new Date()
        };

        tpaConnection.send(JSON.stringify(updateMessage));
      } catch (error) {
        logger.error({ error, roomId: roomData.id, userId }, 'Error sending room update notification');
      }
    }
  }

  /**
   * Get user profile information (placeholder - implement based on your user system)
   */
  private getUserProfile(userId: string): any {
    // TODO: Implement actual user profile fetching
    return {
      userId,
      displayName: userId.split('@')[0] || userId, // Simple fallback
      lastActive: new Date()
    };
  }

  /**
   * Add message to history with rotation
   */
  private addToMessageHistory(packageName: string, messageData: any): void {
    if (!this.messageHistory.has(packageName)) {
      this.messageHistory.set(packageName, []);
    }
    
    const history = this.messageHistory.get(packageName)!;
    history.push(messageData);
    
    // Rotate history if too large
    if (history.length > this.MAX_HISTORY) {
      history.shift();
    }
  }

  /**
   * Get message history for debugging (admin only)
   */
  getMessageHistory(packageName: string): any[] {
    return this.messageHistory.get(packageName) || [];
  }

  /**
   * Get statistics about active TPA sessions
   */
  getStats(): {
    totalPackages: number;
    totalActiveUsers: number;
    totalRooms: number;
    packageStats: Array<{ packageName: string; userCount: number; roomCount: number }>;
  } {
    const packageStats = Array.from(this.activeTpaSessions.entries()).map(([packageName, users]) => ({
      packageName,
      userCount: users.size,
      roomCount: this.packageRooms.get(packageName)?.size || 0
    }));

    return {
      totalPackages: this.activeTpaSessions.size,
      totalActiveUsers: Array.from(this.activeTpaSessions.values()).reduce((sum, users) => sum + users.size, 0),
      totalRooms: this.tpaRooms.size,
      packageStats
    };
  }
}

// Export singleton instance
export const multiUserTpaService = new MultiUserTpaService();
export default multiUserTpaService; 