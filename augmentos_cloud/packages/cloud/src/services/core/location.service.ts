import { User, UserI } from '../../models/user.model';
import { sessionService } from '../session/session.service';
import { logger as rootLogger } from '../logging/pino-logger';
import WebSocket from 'ws';

const logger = rootLogger.child({ service: 'location.service' });

const NAVIGATION_APP_PACKAGE = "com.nathan.nav";

class LocationService {

  public async onAppStarted(userId: string, packageName: string): Promise<void> {
    logger.info({ userId, packageName }, "LocationService: App started event received.");
    if (packageName === NAVIGATION_APP_PACKAGE) {
      logger.info({ userId }, "Navigation app started. Commanding device to use REALTIME location.");
      this._sendCommandToDevice(userId, 'SET_LOCATION_ACCURACY', { rate: 'realtime' });
    }
  }

  public async onAppStopped(userId: string, packageName: string): Promise<void> {
    logger.info({ userId, packageName }, "LocationService: App stopped event received.");
    if (packageName === NAVIGATION_APP_PACKAGE) {
      // For this MVP, we can simply revert to standard when the app stops.
      // A more complex implementation would check if other high-accuracy apps are still running.
      logger.info({ userId }, "Navigation app stopped. Commanding device to use STANDARD location.");
      this._sendCommandToDevice(userId, 'SET_LOCATION_ACCURACY', { rate: 'standard' });
    }
  }

  private _sendCommandToDevice(userId: string, type: string, payload: any): void {
    const userSession = sessionService.getSessionByUserId(userId);
    if (userSession?.websocket && userSession.websocket.readyState === WebSocket.OPEN) {
      try {
        const message = {
          type: type,
          payload: payload,
          timestamp: new Date().toISOString()
        };
        userSession.websocket.send(JSON.stringify(message));
        logger.info({ userId, type, payload }, "Successfully sent command to device.");
      } catch (error) {
          logger.error({error, userId, type}, "Failed to send command to device.")
      }
    } else {
      logger.warn({ userId, type }, "User session or WebSocket not available to send command.");
    }
  }
}

export const locationService = new LocationService();
logger.info("Location Service initialized."); 