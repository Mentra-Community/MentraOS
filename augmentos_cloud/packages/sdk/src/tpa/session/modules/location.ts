import { TpaSession } from '..';
import { StreamType, TpaToCloudMessageType, LocationUpdate, LocationStreamRequest } from '../../../types';

export class LocationManager {
  constructor(private session: TpaSession, private send: (message: any) => void) {}

  public subscribeToStream(options: { accuracy: 'standard' | 'high' | 'realtime' | 'tenMeters' | 'hundredMeters' | 'kilometer' | 'threeKilometers' | 'reduced' }): void {
    const subscription: LocationStreamRequest = { stream: 'location_stream', rate: options.accuracy };
    this.session.subscribe(subscription);
  }

  public unsubscribeFromStream(): void {
    this.session.unsubscribe('location_stream');
  }
  
  public async getLatestLocation(options: { accuracy: string }): Promise<LocationUpdate> {
    return new Promise((resolve, reject) => {
      const requestId = `poll_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      
      // Listen for the specific response
      // @ts-ignore
      const unsubscribe = this.session.events.on('location_update', (data: LocationUpdate) => {
        // @ts-ignore - correlationId will be added to the LocationUpdate type later
        // every time a location update arrives, we check if it has a correlationId that matches the requestId we just created.
        if (data.correlationId === requestId) {
          unsubscribe(); // Stop listening once we get our response
          resolve(data);
        }
      });

      // Send the poll request message to the cloud
      this.send({
        type: TpaToCloudMessageType.LOCATION_POLL_REQUEST,
        correlationId: requestId,
        payload: { accuracy: options.accuracy }
      });

      // Timeout to prevent hanging promises
      setTimeout(() => {
        unsubscribe();
        reject(new Error('Location poll request timed out.'));
      }, 15000); // 15 second timeout
    });
  }
} 