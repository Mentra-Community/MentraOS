---
sidebar_position: 2
title: LocationManager
---

# LocationManager

The `LocationManager` provides a unified, battery-efficient interface for accessing location data. It allows your application to either subscribe to a continuous stream of location updates or request a single, on-demand location fix.

You access the `LocationManager` through the `location` property of an `AppSession` instance:

```typescript
const locationManager = session.location;
```

## How to Get Continuous Location Updates

To get continuous location updates, you must subscribe to the stream and provide a "handler" function that will be called with the data. The method returns an `unsubscribe` function that you should call when you no longer need the updates.

**Example:**

```typescript
// Inside your onSession method...

const stopLocationUpdates = session.location.subscribeToStream(
  { accuracy: 'realtime' },
  (data) => {
    // This function is your handler.
    // It will be called every time a new location update arrives.
    console.log(`New location: ${data.lat}, ${data.lng}`);
    
    // Your app logic here...
    // e.g., update a map, calculate distance, etc.
  }
);

// To stop receiving updates later, just call the function that was returned.
// stopLocationUpdates();
```

## How to Get a Single Location Fix

Use this when you only need the location once, like for tagging a photo or checking the weather.

```typescript
async function checkWeather() {
  try {
    // This gets a single, fresh location fix.
    const location = await session.location.getLatestLocation({ accuracy: 'kilometer' });
    
    // Now you can use the location data.
    const weather = await fetchWeatherFor(location.lat, location.lng);
    session.layouts.showTextWall(`Current weather: ${weather.condition}`);
    
  } catch (error) {
    console.error("Could not get location:", error);
  }
}
```

## Methods

### subscribeToStream()

Subscribes your application to a continuous stream of location data at a specified accuracy tier.

```typescript
subscribeToStream(
  options: { accuracy: string },
  handler: (data: LocationUpdate) => void
): () => void
```

**Parameters:**

*   `options`: An object containing the subscription parameters.
    *   `accuracy`: The desired accuracy tier. Must be one of the tiers listed below.
*   `handler`: The callback function that will be executed with [`LocationUpdate`](/reference/interfaces/event-types#locationupdate) data each time a new location is available.

**Returns:** An `unsubscribe` function to stop this specific subscription.

---

### getLatestLocation()

Retrieves a single, fresh location fix that meets your specified accuracy requirement.

The system is "intelligent":
*   If a high-accuracy stream is already active, it will instantly return the latest data from that stream.
*   If not, it will check for a recently cached location that meets your accuracy requirement.
*   Only as a last resort will it power on the GPS hardware for a new poll.

```typescript
async getLatestLocation(options: { accuracy: string }): Promise<LocationUpdate>
```

**Parameters:**

*   `options`: An object containing the accuracy requirement.
    *   `accuracy`: The desired accuracy tier.

**Returns:** A `Promise` that resolves to a single [`LocationUpdate`](/reference/interfaces/event-types#locationupdate) object.

---

### unsubscribeFromStream()

Stops your application's subscription to the continuous location stream. If no other applications are subscribed to a high-accuracy stream, the system will automatically power down the device's GPS to conserve battery.

**Note:** It is recommended to call the specific `unsubscribe` function returned by `subscribeToStream` to manage individual handlers. This method serves as a general-purpose way to stop all of your app's location subscriptions.

```typescript
unsubscribeFromStream(): void
```

## Accuracy Tiers

You can choose how accurate you need the location data to be. Higher accuracy uses more battery.

| Tier Name | Description |
| :--- | :--- |
| **`realtime`** | Highest accuracy and frequency, for turn-by-turn navigation. |
| **`high`** | High accuracy, but not good enough for turn-by-turn |
| **`tenMeters`** | Accurate to within about 10 meters. |
| **`hundredMeters`** | Accurate to within about one hundred meters. |
| **`kilometer`** | Low-power, accurate to the nearest kilometer. |
| **`threeKilometers`**| Very low-power for large area geofencing. |
| **`reduced`** | Minimal power usage for approximate location. | 