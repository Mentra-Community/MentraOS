# AugmentOS Button Press System

This document outlines how the physical button press system works across the AugmentOS platform, focusing on the interaction between smart glasses, the mobile app, and the cloud services.

## Overview

The AugmentOS button press system provides a flexible mechanism for handling physical button presses on smart glasses. When a user presses a button:

1. The smart glasses client detects the button press
2. The client sends the button press event to the AugmentOS Cloud
3. The cloud checks if any Third-Party Apps (TPAs) are listening for this button event
4. If no TPA is listening, the system performs default actions (e.g., taking a photo)
5. If a TPA is listening, the button press is routed to that app

This design allows physical buttons to have both system-defined default behaviors and app-specific custom behaviors.

## Smart Glasses Client Implementation

### Button Press Detection
*File: `AsgClientService.java`*

The smart glasses client detects button presses through two primary mechanisms:

1. **Text Commands**: The K900 device sends text commands like "cs_pho" (camera button short press) or "cs_vdo" (camera button long press).

   ```java
   // Lines 1312-1355
   public void parseK900Command(String command) {
       switch (command) {
           case "cs_pho":
               Log.d(TAG, "📦 Payload is cs_pho (short press)");
               // Handle photo button press
               getMediaCaptureService().handlePhotoButtonPress();
               break;
               
           case "cs_vdo":
               Log.d(TAG, "📦 Payload is cs_vdo (long press)");
               // Handle video button press
               MediaCaptureService mediaService = getMediaCaptureService();
               if (mediaService != null) {
                   if (mediaService.isRecordingVideo()) {
                       mediaService.stopVideoRecording();
                   } else {
                       mediaService.handleVideoButtonPress();
                   }
               }
               break;
               
           // Other commands...
       }
   }
   ```

2. **JSON Messages**: For more structured communication, the system also supports JSON messages with a "type" field.

   ```java
   // Lines 957-1306
   private void processJsonCommand(JSONObject json) {
       // ...
       String type = dataToProcess.optString("type", "");
       
       switch (type) {
           case "take_photo":
               String requestId = dataToProcess.optString("requestId", "");
               // Handle take photo command
               mMediaCaptureService.takePhotoAndUpload(photoFilePath, requestId);
               break;
               
           // Other message types...
       }
   }
   ```

### Button Press Handling for Photos
*File: `MediaCaptureService.java`*

When a photo button is pressed, the system follows this flow:

```java
// Lines 100-196
public void handlePhotoButtonPress() {
    // Get core token for authentication
    String coreToken = PreferenceManager.getDefaultSharedPreferences(mContext)
            .getString("core_token", "");

    // Get device ID for hardware identification
    String deviceId = android.os.Build.MODEL + "_" + android.os.Build.SERIAL;

    if (coreToken == null || coreToken.isEmpty()) {
        Log.e(TAG, "No core token available, taking photo locally");
        takePhotoLocally();
        return;
    }

    // Prepare REST API call
    try {
        // Get the button press URL from central config
        String buttonPressUrl = ServerConfigUtil.getButtonPressUrl();

        // Create payload for button press event
        JSONObject buttonPressPayload = new JSONObject();
        buttonPressPayload.put("buttonId", "photo");
        buttonPressPayload.put("pressType", "short");
        buttonPressPayload.put("deviceId", deviceId);

        // Make REST API call with timeout
        OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                .writeTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                .build();

        RequestBody requestBody = RequestBody.create(
                MediaType.parse("application/json"),
                buttonPressPayload.toString()
        );

        Request request = new Request.Builder()
                .url(buttonPressUrl)
                .header("Authorization", "Bearer " + coreToken)
                .post(requestBody)
                .build();

        // Execute request asynchronously
        client.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                Log.e(TAG, "Failed to send button press event", e);
                // Connection failed, take photo locally
                takePhotoLocally();
            }

            @Override
            public void onResponse(Call call, Response response) {
                try {
                    if (!response.isSuccessful()) {
                        Log.e(TAG, "Server returned error: " + response.code());
                        // Server error, take photo locally
                        takePhotoLocally();
                        return;
                    }

                    // Parse response
                    String responseBody = response.body().string();
                    Log.d(TAG, "Server response: " + responseBody);
                    JSONObject jsonResponse = new JSONObject(responseBody);

                    // Check if we need to take a photo
                    if ("take_photo".equals(jsonResponse.optString("action"))) {
                        String requestId = jsonResponse.optString("requestId");
                        boolean saveToGallery = jsonResponse.optBoolean("saveToGallery", true);

                        Log.d(TAG, "Server requesting photo with requestId: " + requestId);

                        // Take photo and upload directly to server
                        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
                        String photoFilePath = mContext.getExternalFilesDir(null) + File.separator + "IMG_" + timeStamp + ".jpg";
                        takePhotoAndUpload(photoFilePath, requestId);
                    } else {
                        Log.d(TAG, "Button press handled by server, no photo needed");
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error processing server response", e);
                    takePhotoLocally();
                } finally {
                    response.close();
                }
            }
        });
    } catch (Exception e) {
        Log.e(TAG, "Error preparing button press request", e);
        // Something went wrong, take photo locally
        takePhotoLocally();
    }
}
```

### Photo Capture and Upload
*File: `MediaCaptureService.java`*

Once the system decides to take a photo (either via server request or locally), it uses the `CameraNeo` class to capture and then uploads the photo:

```java
// Lines 507-553
public void takePhotoAndUpload(String photoFilePath, String requestId) {
    // Notify that we're about to take a photo
    if (mMediaCaptureListener != null) {
        mMediaCaptureListener.onPhotoCapturing(requestId);
    }

    try {
        // Use CameraNeo for photo capture
        CameraNeo.takePictureWithCallback(
                mContext,
                photoFilePath,
                new CameraNeo.PhotoCaptureCallback() {
                    @Override
                    public void onPhotoCaptured(String filePath) {
                        Log.d(TAG, "Photo captured successfully at: " + filePath);

                        // Notify that we've captured the photo
                        if (mMediaCaptureListener != null) {
                            mMediaCaptureListener.onPhotoCaptured(requestId, filePath);
                            mMediaCaptureListener.onPhotoUploading(requestId);
                        }

                        // Upload the photo to AugmentOS Cloud
                        uploadMediaToCloud(filePath, requestId, MediaUploadQueueManager.MEDIA_TYPE_PHOTO);
                    }

                    @Override
                    public void onPhotoError(String errorMessage) {
                        Log.e(TAG, "Failed to capture photo: " + errorMessage);
                        // Handle error...
                    }
                }
        );
    } catch (Exception e) {
        Log.e(TAG, "Error taking photo", e);
        // Handle error...
    }
}
```

### Media Upload Queue
*File: `MediaUploadQueueManager.java`*

For reliable media uploads, the system uses a queue manager that:
- Persists upload requests across app restarts
- Handles offline scenarios and retry logic
- Manages upload status tracking

```java
// Lines 158-215
public boolean queueMedia(String mediaFilePath, String requestId, int mediaType) {
    File mediaFile = new File(mediaFilePath);

    // Check if file exists
    if (!mediaFile.exists()) {
        Log.e(TAG, "Failed to queue media - file does not exist: " + mediaFilePath);
        return false;
    }

    // Generate filename based on media type
    String extension = (mediaType == MEDIA_TYPE_PHOTO) ? ".jpg" : ".mp4";
    String queuedFilename = "media_" + System.currentTimeMillis() + "_" + requestId + extension;
    File queuedFile = new File(mQueueDir, queuedFilename);

    try {
        // Copy the file
        copyFile(mediaFile, queuedFile);

        // Add to manifest
        JSONObject mediaEntry = new JSONObject();
        mediaEntry.put("requestId", requestId);
        mediaEntry.put("originalPath", mediaFilePath);
        mediaEntry.put("queuedPath", queuedFile.getAbsolutePath());
        mediaEntry.put("mediaType", mediaType);
        mediaEntry.put("status", STATUS_QUEUED);
        mediaEntry.put("queuedTime", System.currentTimeMillis());
        mediaEntry.put("retryCount", 0);

        boolean added = addMediaToManifest(mediaEntry);

        if (added) {
            Log.d(TAG, "Media queued successfully: " + requestId + " (type: " + mediaType + ")");

            // Notify callback
            if (mCallback != null) {
                mCallback.onMediaQueued(requestId, queuedFile.getAbsolutePath(), mediaType);
            }

            // Schedule upload
            processQueue();

            return true;
        } else {
            // Clean up copied file if adding to manifest failed
            queuedFile.delete();
            Log.e(TAG, "Failed to add media to manifest: " + requestId);
            return false;
        }

    } catch (IOException | JSONException e) {
        Log.e(TAG, "Error queueing media", e);
        // Clean up copied file if there was an error
        queuedFile.delete();
        return false;
    }
}
```

## Cloud Server Implementation

### Button Press API Endpoint
*File: `/packages/cloud/src/routes/hardware.routes.ts` (in augmentos_cloud repository)*

The server provides an endpoint that receives button press events from smart glasses:

```typescript
// POST /api/hardware/button-press
router.post('/button-press', validateGlassesAuth, async (req, res) => {
  try {
    const { buttonId, pressType, deviceId } = req.body;
    const userId = req.user.id;

    // Find the user's active session
    const userSession = await sessionService.getSessionByUserId(userId);
    
    // Check if any TPAs are listening for button events
    const subscribedApps = await subscriptionService.getSubscribedApps(
      userSession, 
      StreamType.BUTTON_PRESS
    );
    
    if (!subscribedApps || subscribedApps.length === 0) {
      // No TPAs are subscribed, handle with system default behavior
      if (buttonId === 'photo' && pressType === 'short') {
        // Create a photo request
        const requestId = await photoRequestService.createSystemPhotoRequest(userId);
        
        // Tell glasses to take a photo
        return res.status(200).json({
          success: true,
          action: 'take_photo',
          requestId
        });
      }
      
      // For other button types, just acknowledge
      return res.status(200).json({ success: true });
    } else {
      // TPAs are handling this button press, just acknowledge
      return res.status(200).json({ success: true });
    }
  } catch (error) {
    console.error('Error handling button press:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

### Photo Request Service
*File: `/packages/cloud/src/services/photoRequest.service.ts` (in augmentos_cloud repository)*

The photo request service manages the lifecycle of photo requests:
- Creates a new requestId for each photo request
- Tracks active photo requests with timeouts
- Associates uploaded photos with the correct requestId
- Makes photos available to users via the gallery API

Key functions:
- `createSystemPhotoRequest(userId)`: Creates a photo request with system origin
- `createAppPhotoRequest(userId, appId)`: Creates a photo request initiated by a TPA
- `handlePhotoUpload(requestId, photoData)`: Associates uploaded photo with a request
- `getPhotosByUserId(userId)`: Retrieves a user's photos for the gallery

## TPA SDK Integration

### AugmentOS SDK Files

TPAs use the AugmentOS SDK to interact with the platform, including requesting photos. The main SDK components for photo requests are:

1. **AugmentOS SDK Client Library**
   *File: `/packages/sdk/src/client.ts`* (in augmentos_cloud repository)
   - Main entry point for TPAs to interact with AugmentOS
   - Handles authentication and session management
   - Provides methods for various platform features

2. **Photo Request Module**
   *File: `/packages/sdk/src/modules/photoRequest.ts`* (in augmentos_cloud repository)
   - Contains methods specifically for photo capture functionality
   - Provides a clean API for TPAs to request photos

3. **WebSocket Communication**
   *File: `/packages/sdk/src/websocket.ts`* (in augmentos_cloud repository)
   - Manages real-time communication between TPAs and the AugmentOS platform
   - Used for delivering photo capture results back to the TPA

4. **TPA Helper Module**
   *Files: `TpaHelpersModule.java` and `TpaHelpersPackage.java`* (in augmentos_manager repository)
   - Native modules that provide helper functions for TPAs
   - Includes functionality for launching apps and checking installation status

### SDK API for Photo Requests

The SDK provides an API for TPAs to request photos. Here's an example of how a TPA would use the SDK to request a photo:

```typescript
// Example TPA code using AugmentOS SDK
import { AugmentOSClient } from 'augmentos-sdk';

// Initialize the client
const client = new AugmentOSClient({
  appId: 'com.example.myapp',
  apiKey: 'your-api-key'
});

// Request a photo
async function capturePhoto() {
  try {
    // Request a photo and get back a requestId
    const { requestId } = await client.photos.requestCapture({
      saveToGallery: true,  // Whether to save to user's gallery
      quality: 'high'       // Photo quality
    });
    
    console.log(`Photo request sent with ID: ${requestId}`);
    
    // Wait for the photo to be captured and processed
    const photoResult = await client.photos.waitForResult(requestId, {
      timeout: 30000  // 30 seconds timeout
    });
    
    console.log(`Photo captured: ${photoResult.url}`);
    
    // Use the photo in your app
    processPhoto(photoResult.url);
    
  } catch (error) {
    console.error('Error capturing photo:', error);
  }
}
```

### Backend Server API Endpoints

*Files in `/packages/cloud/src/routes/` (in augmentos_cloud repository)*

The cloud server provides these endpoints for TPA photo requests:

1. **Request Photo Capture**
   - `POST /api/tpa/photos/request`
   - Requires TPA authentication
   - Returns a requestId for tracking the photo

2. **Get Photo Result**
   - `GET /api/tpa/photos/:requestId`
   - Retrieves the result of a photo request
   - Returns photo URL if available or status information

3. **Subscribe to Photo Events**
   - `POST /api/tpa/subscribe`
   - Allows TPAs to subscribe to real-time events
   - Can be used to receive notifications when photos are ready

### TPA Message Handler
*File: `/packages/cloud/src/handlers/tpaMessage.handler.ts`* (in augmentos_cloud repository)

Handles messages between TPAs and the AugmentOS platform:
- Processes incoming requests from TPAs
- Routes photo requests to the appropriate services
- Handles permissions and rate limiting

## TPA Photo Request System

When a third-party app (TPA) needs to take a photo with the AugmentOS platform, it follows a different flow from the physical button press system.

### TPA-Initiated Photo Request Flow

1. **TPA Makes API Request to Cloud**
   - TPA sends a request to an AugmentOS Cloud API endpoint to take a photo
   - The request includes the TPA's identification and authentication
   - The cloud validates the TPA's permissions to request photos

2. **Cloud Generates Request ID**
   - Cloud generates a unique `requestId` for the photo request
   - This `requestId` is used to track the photo through the system
   - The request is associated with the user's ID and the TPA's ID

3. **Cloud Forwards Request to Glasses via Mobile App**
   - The cloud sends a WebSocket message to the user's mobile app
   - Mobile app receives the message through `CoreCommunicator.tsx` with a unique request type
   - The message contains the action "take_photo" and the `requestId`

4. **Mobile App Relays Request to Glasses**
   - The mobile app forwards the photo request to the connected glasses
   - The message is sent via Bluetooth using the `bluetoothManager` in `AsgClientService.java`
   - Glasses receive a JSON message with type "take_photo" and the `requestId`

5. **Glasses Take and Upload Photo**
   - *File: `AsgClientService.java` (lines 1021-1038)*
   ```java
   case "take_photo":
       String requestId = dataToProcess.optString("requestId", "");
       
       if (requestId.isEmpty()) {
           Log.e(TAG, "Cannot take photo - missing requestId");
           return;
       }
       
       // Generate a temporary file path for the photo
       String timeStamp = new java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US).format(new java.util.Date());
       String photoFilePath = getExternalFilesDir(null) + java.io.File.separator + "IMG_" + timeStamp + ".jpg";
   
       Log.d(TAG, "Taking photo with requestId: " + requestId);
       Log.d(TAG, "Photo will be saved to: " + photoFilePath);
       
       // Take the photo using CameraNeo
       mMediaCaptureService.takePhotoAndUpload(photoFilePath, requestId);
       break;
   ```
   - The glasses take the photo using the `MediaCaptureService`
   - The photo is automatically queued for upload with the `requestId`

6. **Cloud Processes Uploaded Photo**
   - Photo uploads are handled by the `MediaUploadService`
   - The cloud receives the photo with the `requestId`
   - It associates the photo with the original TPA request
   - The photo is stored in the cloud's storage system

7. **TPA Notification & Access**
   - The cloud notifies the TPA that the photo is ready (via WebSocket or callback)
   - The TPA can access the photo via a URL or download endpoint
   - The TPA may receive temporary access credentials to view the photo

8. **Photo Metadata & Gallery Storage**
   - The photo is stored with metadata including:
     - `requestId`: The unique identifier for this request
     - `appId`: The ID of the TPA that requested the photo
     - `userId`: The ID of the user who captured the photo
     - `timestamp`: When the photo was captured
   - The photo appears in the user's gallery in the AugmentOS Manager app
   - Users can view, share or delete the photo via the gallery UI

### Gallery Integration
*File: `BackendServerComms.tsx` (lines 42-78)*

The mobile app can fetch and display photos from the cloud gallery:

```typescript
public async getGalleryPhotos(): Promise<any> {
  if (!this.coreToken) {
    throw new Error('No core token available for authentication');
  }

  const url = `${this.serverUrl}/api/gallery`;
  console.log('Fetching gallery photos from:', url);

  const config: AxiosRequestConfig = {
    method: 'GET',
    url,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.coreToken}`,
    },
  };

  try {
    const response = await axios(config);
    if (response.status === 200 && response.data) {
      console.log('Received gallery photos:', response.data);
      return response.data;
    } else {
      throw new Error(`Bad response: ${response.statusText}`);
    }
  } catch (error: any) {
    console.error('Error fetching gallery photos:', error.message || error);
    throw error;
  }
}
```

## Third-Party App (TPA) Integration

### TPA Subscription System
*File: `/packages/cloud/src/services/subscription.service.ts`* (in augmentos_cloud repository)

The subscription service allows TPAs to register for specific events:
- TPAs can subscribe to button press events via API
- Subscriptions are associated with user sessions
- When a subscribed event occurs, the server routes it to the TPA

### TPA Communication
*Components across AugmentOS platform*

For TPAs to handle button presses:
1. The TPA subscribes to button events via the cloud API
2. When a button is pressed, the cloud checks for subscribed TPAs
3. If a TPA is subscribed, the event is routed to that TPA
4. The TPA can then respond with custom actions
5. The TPA can also initiate its own photo requests via the cloud API

## Complete Flow: Photo Button Press Example

1. **User presses the photo button on smart glasses**
   - *File: `AsgClientService.java`*
   - Physical button press detected
   - `parseK900Command()` identifies "cs_pho" command
   - Calls `handlePhotoButtonPress()`

2. **Client prepares and sends button press event to cloud**
   - *File: `MediaCaptureService.java`*
   - Constructs JSON payload with buttonId, pressType, deviceId
   - Sends authenticated POST request to button press URL
   
3. **Cloud server receives and processes button press**
   - *File: `/packages/cloud/src/routes/hardware.routes.ts`*
   - Validates authentication
   - Identifies the user and their active session
   - Checks if any TPAs are subscribed to this button event
   
4. **Decision point: TPA handling vs. System handling**
   - If TPAs are subscribed:
     - Returns simple success response
     - TPA handles the button press event
   
   - If no TPAs are subscribed:
     - Creates a system photo request with unique requestId
     - Returns action "take_photo" with the requestId
   
5. **Smart glasses client receives the response**
   - *File: `MediaCaptureService.java`*
   - Parses response and checks for "take_photo" action
   - Extracts requestId from response
   - Calls `takePhotoAndUpload()` with the requestId
   
6. **Photo capture and upload**
   - *Files: `MediaCaptureService.java`, `MediaUploadQueueManager.java`*
   - Captures photo using CameraNeo
   - Queues photo for upload with requestId
   - Uploads photo to cloud server
   
7. **Cloud server processes uploaded photo**
   - Associates the uploaded photo with the original requestId
   - Stores the photo in the user's gallery
   - Makes the photo available via the gallery API

8. **Mobile app access to photos**
   - *Files: `BackendServerComms.tsx`, `GlassesRecordingsGallery.tsx`*
   - App fetches photos from `/api/gallery` endpoint
   - Displays photos in the gallery UI
   - Allows viewing, sharing, and deleting photos

## Special Cases and Error Handling

### Offline Operation
If the smart glasses cannot connect to the cloud:
- *File: `MediaCaptureService.java`*
- `takePhotoLocally()` is called
- Generates a local requestId prefixed with "local_"
- Captures and stores photo locally
- Queues for later upload when connectivity is restored

### Upload Failures
If a photo upload fails:
- *File: `MediaUploadQueueManager.java`*
- Failed uploads are marked in the queue
- `retryFailedUploads()` can attempt to retry
- The queue persists across app restarts

### Video Recording
Similar flow to photos but with longer duration:
- *File: `MediaCaptureService.java`*
- `handleVideoButtonPress()` sends button event to cloud
- Can start/stop recording based on server response
- Video files are queued and uploaded similar to photos

## Conclusion

The AugmentOS button press system provides a flexible framework for handling physical button presses on smart glasses. The system prioritizes TPA integrations, allowing third-party apps to override default behaviors, but falls back to system-defined actions when no TPA is listening. This architecture supports both online and offline scenarios, ensuring that users can always capture photos and videos regardless of connectivity status.

TPAs can also directly request photos through the AugmentOS SDK, following a different but complementary flow to the physical button press system. This allows applications to capture photos programmatically at the appropriate moments within their user experience.