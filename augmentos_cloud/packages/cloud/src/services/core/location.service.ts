import { User, UserI } from '../../models/user.model';
import { sessionService } from '../session/session.service';
import { logger as rootLogger } from '../logging/pino-logger';
import WebSocket from 'ws';

const logger = rootLogger.child({ service: 'location.service' });

class LocationService {

  public async onAppStarted(userId: string, packageName: string): Promise<void> {
    logger.info({ userId, packageName }, "LocationService: App started event received.");
    // Full logic to be implemented in a later step
  }

  public async onAppStopped(userId: string, packageName: string): Promise<void> {
    logger.info({ userId, packageName }, "LocationService: App stopped event received.");
    // Full logic to be implemented in a later step
  }

  private _sendCommandToDevice(userId: string, type: string, payload: any): void {
    logger.info({ userId, type, payload }, "LocationService: Would send command to device.");
    // Full logic to be implemented in a later step
  }
}

export const locationService = new LocationService();
logger.info("Location Service initialized."); 