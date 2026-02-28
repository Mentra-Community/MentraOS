import {locationWarnLog} from "../../../utils/permissions-utils"

import {AppSession} from ".."
import {AppToCloudMessageType, LocationUpdate, LocationStreamRequest} from "../../../types"

export class LocationManager {
  private session: AppSession
  private lastLocationCleanupHandler: () => void = () => {}

  constructor(session: AppSession) {
    this.session = session
  }

  // subscribes to the continuous location stream with a specified accuracy tier
  public subscribeToStream(
    options: {
      accuracy:
        | "standard"
        | "high"
        | "realtime"
        | "tenMeters"
        | "hundredMeters"
        | "kilometer"
        | "threeKilometers"
        | "reduced"
    },
    handler: (data: LocationUpdate) => void,
  ): () => void {
    //Checking for permission location from dev console:
    locationWarnLog(this.session.getHttpsServerUrl() || "", this.session.getPackageName(), this.subscribeToStream.name)

    const subscription: LocationStreamRequest = {
      stream: "location_stream",
      rate: options.accuracy,
    }
    this.session.subscribe(subscription)
    this.lastLocationCleanupHandler = this.session.events.onLocation(handler)
    return this.lastLocationCleanupHandler
  }

  // unsubscribes from the continuous location stream
  public unsubscribeFromStream(): void {
    if (this.lastLocationCleanupHandler) {
      this.lastLocationCleanupHandler()
      this.lastLocationCleanupHandler = () => {}
    } else {
      this.session.unsubscribe("location_stream")
    }
  }

  // performs a one-time, intelligent poll for a location fix
  public async getLatestLocation(options: {accuracy: string}): Promise<LocationUpdate> {
    return new Promise((resolve, reject) => {
      const requestId = `poll_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

      // listens for a location update with a matching correlationId
      const unsubscribe = this.session.events.on("location_update", (data: LocationUpdate) => {
        if (data.correlationId === requestId) {
          unsubscribe() // clean up the listener
          resolve(data)
        }
      })

      // sends the poll request message to the cloud
      this.session.sendMessage({
        type: AppToCloudMessageType.LOCATION_POLL_REQUEST,
        correlationId: requestId,
        packageName: this.session.getPackageName(),
        sessionId: this.session.getSessionId(),
        accuracy: options.accuracy,
      })

      // sets a timeout to prevent the promise from hanging indefinitely
      setTimeout(() => {
        unsubscribe()
        reject("Location poll request timed out")
      }, 15000) // 15 second timeout
    })
  }
}
