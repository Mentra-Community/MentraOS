package com.augmentos.augmentos_core.augmentos_backend;

import android.content.Context;
import android.os.Environment;
import android.util.Log;

import com.augmentos.augmentos_core.BuildConfig;
import com.augmentos.augmentos_core.CalendarItem;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.AsrStreamKey;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.augmentos.SpeechRecAugmentos;
import com.augmentos.augmentoslib.enums.AsrStreamType;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

import okhttp3.RequestBody;
import okhttp3.Request;
import okhttp3.OkHttpClient;
import okhttp3.Callback;
import okhttp3.Response;
import okhttp3.Call;

/**
 * ServerComms is the single facade for all WebSocket interactions in AugmentOS_Core.
 * It delegates the low-level socket to WebSocketManager, handles handshake, routing messages,
 * and provides methods to send audio, VAD, phone notifications, hardware events, etc.
 *
 * This class also calls back into SpeechRecAugmentos for "interim"/"final" messages.
 */
public class ServerComms {
    private static final String TAG = "WearableAi_ServerComms";

    private final WebSocketManager wsManager;
    private SpeechRecAugmentos speechRecAugmentos; // callback for speech messages
    private ServerCommsCallback serverCommsCallback;
    // 1) Keep a private static reference
    private static ServerComms instance;
    private String coreToken;
    private Context context;

    // ------------------------------------------------------------------------
    // AUDIO QUEUE SYSTEM (IMPROVED)
    // ------------------------------------------------------------------------
    // Live queue for immediate sending (small buffer)
    private final BlockingQueue<byte[]> liveAudioQueue = new ArrayBlockingQueue<>(100); // ~1 second buffer
    // Sliding buffer to store recent audio in case of disconnection
    private final BlockingQueue<byte[]> slidingBuffer = new ArrayBlockingQueue<>((int) (3 / 0.01 / 10)); // 3 seconds sliding buffer
    private Thread audioSenderThread;
    private volatile boolean audioSenderRunning = false;
    private volatile boolean isReconnecting = false;
    private volatile boolean isProcessingBuffer = false;

    // ------------------------------------------------------------------------
    // PCM RECORDING SYSTEM (ADDED)
    // ------------------------------------------------------------------------
    private FileOutputStream pcmFileOutputStream = null;
    private long recordingStartTime = 0;
    private long bytesWritten = 0;
    private static final long RECORDING_DURATION_MS = 20000; // 20 seconds
    private static final String PCM_RECORDING_FOLDER = "AugmentOS_PCM_Recordings";

    public static synchronized ServerComms getInstance(Context context) {
        if (instance == null) {
            instance = new ServerComms(context);
        }
        return instance;
    }

    public static synchronized ServerComms getInstance() {
        if (instance == null) {
            throw new IllegalStateException("ServerComms not initialized. Call getInstance(Context) first.");
        }
        return instance;
    }

    public void setServerCommsCallback(ServerCommsCallback callback) {
        this.serverCommsCallback = callback;
    }

    private ServerComms(Context context) {
        this.context = context;
        // Create the underlying WebSocketManager (OkHttp-based).
        this.wsManager = new WebSocketManager(context, new WebSocketManager.IncomingMessageHandler() {
            @Override
            public void onIncomingMessage(JSONObject msg) {
                handleIncomingMessage(msg);
            }

            @Override
            public void onConnectionOpen() {
                // Set the reconnecting flag so the audio thread knows to send the buffer
                isReconnecting = true;

                // As soon as the connection is open, send the "connection_init" message
                // that your server expects.
                new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                    try {
                        JSONObject initMsg = new JSONObject();
                        initMsg.put("type", "connection_init");
                        // You can send any additional fields if your server needs them, e.g. "userId".
                        initMsg.put("coreToken", coreToken);
                        // add more fields if needed, e.g. initMsg.put("someField", "someValue");

                        // Send the JSON over the WebSocket
                        wsManager.sendText(initMsg.toString());
                        Log.d(TAG, "Sent delayed connection_init message");

                    } catch (JSONException e) {
                        Log.e(TAG, "Error building connection_init JSON", e);
                    }
                }, 1000);
            }

            @Override
            public void onConnectionClosed() {
                // Optional: place logic if needed on close
                stopAudioSenderThread();
                stopPcmRecording(); // Close any open recording file
            }

            @Override
            public void onError(String error) {
                // Log errors
                Log.e(TAG, "WebSocket error: " + error);
                stopAudioSenderThread();
                stopPcmRecording(); // Close any open recording file
//                if (serverCommsCallback != null)
//                    serverCommsCallback.onConnectionError("Websocket error");
            }

            @Override
            public void onConnectionStatusChange(WebSocketStatus status) {
                if(serverCommsCallback != null)
                    serverCommsCallback.onConnectionStatusChange(status);
            }
        });
    }

    /**
     * We can have a reference to the SpeechRecAugmentos module
     * so we can call it when we receive transcription/translation messages.
     */
    public void setSpeechRecAugmentos(SpeechRecAugmentos sr) {
        this.speechRecAugmentos = sr;
    }

    /**
     * Opens the WebSocket to the given URL (e.g. "ws://localhost:7002/glasses-ws").
     * Only connects if truly needed based on connection state.
     */
    public void connectWebSocket(String coreToken) {
        // Don't reconnect if we're already connected
        if (wsManager.isConnected()) {
            Log.d(TAG, "WebSocket already connected, skipping connection");
            return;
        }
        
        this.coreToken = coreToken;
        wsManager.connect(getServerUrl(), coreToken);
    }

    /**
     * Disconnects the WebSocket (normal closure).
     */
    public void disconnectWebSocket() {
        wsManager.disconnect();
        stopAudioSenderThread();  // Stop the audio queue thread
        stopPcmRecording(); // Close any open recording file
    }

    /**
     * Checks if we are currently connected.
     */
    public boolean isWebSocketConnected() {
        return wsManager.isConnected();
    }

    // ------------------------------------------------------------------------
    // AUDIO / VAD
    // ------------------------------------------------------------------------

    /**
     * Sends a raw PCM audio chunk as binary data.
     * More efficient handling that only processes audio when actually needed.
     */
    public void sendAudioChunk(byte[] audioData) {
        // If audio sender thread isn't running, don't even queue data
        if (audioSenderThread == null) {
            return; // Skip processing entirely if sender thread isn't active
        }
        
        // Clone only once to avoid unnecessary copies
        byte[] copiedData = audioData.clone();

        // Add to live queue - if full, just drop (we prioritize newest audio)
        if (!liveAudioQueue.offer(copiedData)) {
            liveAudioQueue.poll(); // Remove oldest
            liveAudioQueue.offer(copiedData); // Add new
        }

        // Only add to sliding buffer if we're not actively processing it
        // to prevent buffering data we're currently sending
        if (!isProcessingBuffer) {
            // Also maintain sliding buffer - always keep most recent 10 seconds
            if (!slidingBuffer.offer(copiedData.clone())) {  // Clone again for separate instance
                slidingBuffer.poll(); // Remove oldest
                slidingBuffer.offer(copiedData.clone()); // Add new
            }
        }
    }

    /**
     * Sends audio from the sliding buffer to catch up after a reconnection
     */
    private void sendSlidingBufferAudio() {
        Log.d(TAG, "Sending cached audio from sliding buffer...");
        List<byte[]> bufferContents = new ArrayList<>();

        // Set flag to prevent adding new data to sliding buffer while we're processing it
        isProcessingBuffer = true;

        // Drain the sliding buffer to a list to preserve order
//        slidingBuffer.drainTo(bufferContents);

        // Send all buffer contents in order
        for (byte[] chunk : bufferContents) {
            if (wsManager.isConnected()) {
                wsManager.sendBinary(chunk);
                // Debug - Write to PCM file as we send
                 writeToPcmFile(chunk);
            } else {
                // If connection drops during playback, stop sending
                break;
            }
        }

        // Clear the live queue to avoid sending duplicate audio after buffer replay
        liveAudioQueue.clear();

        Log.d(TAG, "Sent " + bufferContents.size() + " cached audio chunks");

        // Reset flag so we can start buffering again
        isProcessingBuffer = false;
    }

    // ------------------------------------------------------------------------
    // PCM RECORDING METHODS (ADDED)
    // ------------------------------------------------------------------------

    /**
     * Starts a new PCM recording session, creating a new file.
     */
    private void startPcmRecording() {
        try {
            // Create directory if it doesn't exist
            File recordingDir = new File(context.getExternalFilesDir(null), PCM_RECORDING_FOLDER);
            if (!recordingDir.exists()) {
                recordingDir.mkdirs();
            }

            // Create a unique filename with timestamp
            SimpleDateFormat sdf = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US);
            String timestamp = sdf.format(new Date());
            File outputFile = new File(recordingDir, "pcm_recording_" + timestamp + ".pcm");

            // Open file stream
            pcmFileOutputStream = new FileOutputStream(outputFile);
            recordingStartTime = System.currentTimeMillis();
            bytesWritten = 0;

            Log.e(TAG, "📢 PCM RECORDING STARTED: " + outputFile.getAbsolutePath() + " 📢");
        } catch (IOException e) {
            Log.e(TAG, "Failed to create PCM recording file", e);
            pcmFileOutputStream = null;
        }
    }

    /**
     * Writes audio data to the PCM file and checks if we've reached the recording duration.
     */
    private void writeToPcmFile(byte[] audioData) {
        if (pcmFileOutputStream == null) {
            startPcmRecording();
        }

        try {
            // Write the audio data to file
            pcmFileOutputStream.write(audioData);
            bytesWritten += audioData.length;

            // Check if we've recorded for the specified duration
            long elapsedTime = System.currentTimeMillis() - recordingStartTime;
            if (elapsedTime >= RECORDING_DURATION_MS) {
                stopPcmRecording();
            }
        } catch (IOException e) {
            Log.e(TAG, "Error writing to PCM file", e);
            stopPcmRecording();
        }
    }

    /**
     * Closes the current PCM recording file.
     */
    private void stopPcmRecording() {
        if (pcmFileOutputStream != null) {
            try {
                pcmFileOutputStream.close();
                Log.e(TAG, "📢 PCM RECORDING COMPLETED: " + bytesWritten + " bytes written 📢");
                // Clear the file stream reference but don't start a new recording
                pcmFileOutputStream = null;
            } catch (IOException e) {
                Log.e(TAG, "Error closing PCM file", e);
            }
        }
    }

    /**
     * Sends a VAD message to indicate speaking or not.
     */
    public void sendVadStatus(boolean isSpeaking) {
        JSONObject vadMsg = new JSONObject();
        try {
            vadMsg.put("type", "VAD");
            vadMsg.put("status", isSpeaking);
            wsManager.sendText(vadMsg.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building VAD JSON", e);
        }
    }

    /**
     * If you want to update your ASR config (list of languages, translations),
     * call this from SpeechRecAugmentos.
     */
    public void updateAsrConfig(List<AsrStreamKey> languages) {
        if (!wsManager.isConnected()) {
            Log.e(TAG, "Cannot send ASR config: not connected.");
            return;
        }

        try {
            JSONObject configMsg = new JSONObject();
            configMsg.put("type", "config");

            JSONArray streamsArray = new JSONArray();
            for (AsrStreamKey key : languages) {
                JSONObject streamObj = new JSONObject();
                if (key.streamType == AsrStreamType.TRANSCRIPTION) {
                    streamObj.put("streamType", "transcription");
                } else {
                    streamObj.put("streamType", "translation");
                }
                streamObj.put("transcribeLanguage", key.transcribeLanguage);
                if (key.streamType == AsrStreamType.TRANSLATION) {
                    streamObj.put("translateLanguage", key.translateLanguage);
                }
                streamsArray.put(streamObj);
            }
            configMsg.put("streams", streamsArray);

            wsManager.sendText(configMsg.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building config message", e);
        }
    }

    // ------------------------------------------------------------------------
    // APP LIFECYCLE (if needed)
    // ------------------------------------------------------------------------

    public void startApp(String packageName) {
        try {
            JSONObject msg = new JSONObject();
            msg.put("type", "start_app");
            msg.put("packageName", packageName);
            msg.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(msg.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building start_app JSON", e);
        }
    }

    public void stopApp(String packageName) {
        try {
            JSONObject msg = new JSONObject();
            msg.put("type", "stop_app");
            msg.put("packageName", packageName);
            msg.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(msg.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building stop_app JSON", e);
        }
    }

    // ------------------------------------------------------------------------
    // PHONE NOTIFICATIONS (if needed)
    // ------------------------------------------------------------------------

    public void sendPhoneNotification(String notificationId, String app, String title, String content, String priority) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "phone_notification");
            event.put("notificationId", notificationId);
            event.put("app", app);
            event.put("title", title);
            event.put("content", content);
            event.put("priority", priority);
            event.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(event.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building phone_notification JSON", e);
        }
    }

    // ------------------------------------------------------------------------
    // HARDWARE EVENTS (if needed)
    // ------------------------------------------------------------------------

    public void sendButtonPress(String buttonId, String pressType) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "button_press");
            event.put("buttonId", buttonId);
            event.put("pressType", pressType);
            event.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(event.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building button_press JSON", e);
        }
    }

    public void sendHeadPosition(String position) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "head_position");
            event.put("position", position);
            event.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(event.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building head_position JSON", e);
        }
    }

    public void sendGlassesBatteryUpdate(int level, boolean charging, Integer timeRemaining) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "glasses_battery_update");
            event.put("level", level);
            event.put("charging", charging);
            event.put("timestamp", System.currentTimeMillis());
            if (timeRemaining != null) {
                event.put("timeRemaining", timeRemaining);
            }
            wsManager.sendText(event.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building battery_update JSON", e);
        }
    }


    public void sendPhoneBatteryUpdate(int level, boolean charging, Integer timeRemaining) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "phone_battery_update");
            event.put("level", level);
            event.put("charging", charging);
            event.put("timestamp", System.currentTimeMillis());
            if (timeRemaining != null) {
                event.put("timeRemaining", timeRemaining);
            }
            wsManager.sendText(event.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building battery_update JSON", e);
        }
    }

    public void sendGlassesConnectionState(String modelName, String status) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "glasses_connection_state");
            event.put("modelName", modelName);
            event.put("status", status);
            event.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(event.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building button_press JSON", e);
        }
    }

    public void sendLocationUpdate(double lat, double lng) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "location_update");
            event.put("lat", lat);
            event.put("lng", lng);
            event.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(event.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building location_update JSON", e);
        }
    }

    public void sendCalendarEvent(CalendarItem calendarItem) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "calendar_event");
            event.put("title", calendarItem.getTitle());
            event.put("eventId", calendarItem.getEventId());
            event.put("dtStart", calendarItem.getDtStart());
            event.put("dtEnd", calendarItem.getDtEnd());
            event.put("timeZone", calendarItem.getTimeZone());
            event.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(event.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building calendar_update JSON", e);
        }
    }

    public void sendCoreStatus(JSONObject status) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "core_status_update");
            event.put("status", status);
            event.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(event.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error building location_update JSON", e);
        }
    }
    
    /**
     * Sends a photo response message to the server
     * 
     * @param requestId The unique ID of the photo request
     * @param photoUrl URL of the uploaded photo
     */
    public void sendPhotoResponse(String requestId, String photoUrl) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "photo_response");
            event.put("requestId", requestId);
            event.put("photoUrl", photoUrl);
            event.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(event.toString());
            Log.d(TAG, "Sent photo response for requestId: " + requestId);
        } catch (JSONException e) {
            Log.e(TAG, "Error building photo_response JSON", e);
        }
    }
    
    /**
     * Sends a video stream response message to the server
     * 
     * @param appId The ID of the app requesting the stream
     * @param streamUrl URL of the video stream
     */
    public void sendVideoStreamResponse(String appId, String streamUrl) {
        try {
            JSONObject event = new JSONObject();
            event.put("type", "video_stream_response");
            event.put("appId", appId);
            event.put("streamUrl", streamUrl);
            event.put("timestamp", System.currentTimeMillis());
            wsManager.sendText(event.toString());
            Log.d(TAG, "Sent video stream response for appId: " + appId);
        } catch (JSONException e) {
            Log.e(TAG, "Error building video_stream_response JSON", e);
        }
    }

    /**
     * Requests settings from server via WebSocket
     */
    public void requestSettingsFromServer() {
        try {
            Log.d(TAG, "Requesting settings from server");
            JSONObject settingsRequest = new JSONObject();
            settingsRequest.put("type", "settings_update_request");
            wsManager.sendText(settingsRequest.toString());
        } catch (JSONException e) {
            Log.e(TAG, "Error creating settings request", e);
        }
    }

    // ------------------------------------------------------------------------
    // INTERNAL: Message Handling
    // ------------------------------------------------------------------------

    /**
     * Called by wsManager when a new JSON message arrives.
     */
    private void handleIncomingMessage(JSONObject msg) {
        String type = msg.optString("type", "");
        JSONObject userSession;
        JSONArray installedApps;
        JSONArray activeAppPackageNames;

        // Log.d(TAG, "Received message of type: " + type);
        // Log.d(TAG, "Full message: " + msg.toString());

//        Log.d(TAG, "Received message of type: " + msg);

        switch (type) {
            case "connection_ack":
                Log.d(TAG, "Received connection_ack. Possibly store sessionId if needed.");
                startAudioSenderThread();
                if (serverCommsCallback != null) {
                    // Log.d( TAG, "Calling onConnectionAck callback");
                    // Log.d(TAG, "Apps installed: " + msg);
                    serverCommsCallback.onAppStateChange(parseAppList(msg));
                    serverCommsCallback.onConnectionAck();
                    requestSettingsFromServer();
                }
                break;

            case "app_state_change":
                //Log.d(TAG, "Received app_state_change.");
                // Log.d( TAG, "Calling onConnectionAck callback");
                // Log.d(TAG, "Apps installed: " + msg);
                if (serverCommsCallback != null)
                    serverCommsCallback.onAppStateChange(parseAppList(msg));
                break;

            case "connection_error":
                String errorMsg = msg.optString("message", "Unknown error");
                //Log.e(TAG, "connection_error from server: " + errorMsg);
                if (serverCommsCallback != null)
                    serverCommsCallback.onConnectionError(errorMsg);
                break;

            case "auth_error":
                //Log.d(TAG, "Server is requesting a reconnect.");
                disconnectWebSocket();
                if (serverCommsCallback != null)
                    serverCommsCallback.onAuthError();
                break;

            case "microphone_state_change":
                boolean isMicrophoneEnabled = msg.optBoolean("isMicrophoneEnabled", true);
                //Log.d(TAG, "Received turn_microphone_on message." + isMicrophoneEnabled);
                if (serverCommsCallback != null)
                    serverCommsCallback.onMicrophoneStateChange(isMicrophoneEnabled);
                break;
                
            case "photo_request":
                String requestId = msg.optString("requestId");
                String appId = msg.optString("appId");
                Log.d(TAG, "Received photo_request, requestId: " + requestId + ", appId: " + appId);
                if (serverCommsCallback != null && !requestId.isEmpty() && !appId.isEmpty()) {
                    serverCommsCallback.onPhotoRequest(requestId, appId);
                } else {
                    Log.e(TAG, "Invalid photo request: missing requestId or appId");
                }
                break;
                
            case "video_stream_request":
                String videoAppId = msg.optString("appId");
                Log.d(TAG, "Received video_stream_request, appId: " + videoAppId);
                if (serverCommsCallback != null && !videoAppId.isEmpty()) {
                    serverCommsCallback.onVideoStreamRequest(videoAppId);
                } else {
                    Log.e(TAG, "Invalid video stream request: missing appId");
                }
                break;

            case "display_event":
                //Log.d(TAG, "Received display_event: " + msg.toString());
                String view = msg.optString("view");
                boolean isDashboard = view.equals("dashboard");

                if (serverCommsCallback == null) return;

                if(isDashboard)
                    serverCommsCallback.onDashboardDisplayEvent(msg);
                else
                    serverCommsCallback.onDisplayEvent(msg);
                break;

            case "request_single":
                //Log.d(TAG, "Received request_core_status: " + msg.toString());
                String dataType = msg.optString("data_type");
                if (serverCommsCallback != null)
                    serverCommsCallback.onRequestSingle(dataType);
                break;

            case "interim":
            case "final":
                // Pass speech messages to SpeechRecAugmentos
                if (speechRecAugmentos != null) {
                    speechRecAugmentos.handleSpeechJson(msg);
                } else {
                    Log.w(TAG, "Received speech message but speechRecAugmentos is null!");
                }
                break;

            case "settings_update":
                Log.d(TAG, "Received settings update from WebSocket");
                try {
                    JSONObject settings = msg.optJSONObject("settings");
                    if (settings != null && serverCommsCallback != null) {
                        serverCommsCallback.onSettingsUpdate(settings);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error handling settings update", e);
                }
                break;

            case "reconnect":
                Log.d(TAG, "Server is requesting a reconnect.");
                break;

            case "app_started":
                String startedPackage = msg.optString("packageName", "");
                if (serverCommsCallback != null) {
                    serverCommsCallback.onAppStarted(startedPackage);
                }
                break;

            case "app_stopped":
                String stoppedPackage = msg.optString("packageName", "");
                if (serverCommsCallback != null) {
                    serverCommsCallback.onAppStopped(stoppedPackage);
                }
                break;

            default:
                Log.w(TAG, "Unknown message type: " + type + " / full: " + msg.toString());
                break;
        }
    }

    private String getServerUrl() {
        String host = BuildConfig.AUGMENTOS_HOST;// EnvHelper.getEnv("AUGMENTOS_HOST");
        String port = BuildConfig.AUGMENTOS_PORT;// EnvHelper.getEnv("AUGMENTOS_PORT");
        boolean secureServer = Boolean.parseBoolean(BuildConfig.AUGMENTOS_SECURE);// Boolean.parseBoolean(EnvHelper.getEnv("AUGMENTOS_SECURE"));
        if (host == null || port == null) {
            throw new IllegalStateException("AugmentOS Server Config Not Found");
        }

        // Could do "ws://" for dev or "wss://" for secure
        return String.format("%s://%s:%s/glasses-ws", secureServer ? "wss" : "ws", host, port);
    }

    public static List<ThirdPartyCloudApp> parseAppList(JSONObject msg) {
        // 1) Try to grab installedApps at the top level
        JSONArray installedApps = msg.optJSONArray("installedApps");

        // 2) If not found, look for "userSession.installedApps"
        if (installedApps == null) {
            JSONObject userSession = msg.optJSONObject("userSession");
            if (userSession != null) {
                installedApps = userSession.optJSONArray("installedApps");
            }
        }

        // 3) Similarly, try to find activeAppPackageNames at top level or under userSession
        JSONArray activeAppPackageNames = msg.optJSONArray("activeAppPackageNames");
        if (activeAppPackageNames == null) {
            JSONObject userSession = msg.optJSONObject("userSession");
            if (userSession != null) {
                activeAppPackageNames = userSession.optJSONArray("activeAppPackageNames");
            }
        }

        // 4) Convert activeAppPackageNames into a Set for easy lookup
        Set<String> runningPackageNames = new HashSet<>();
        if (activeAppPackageNames != null) {
            for (int i = 0; i < activeAppPackageNames.length(); i++) {
                String packageName = activeAppPackageNames.optString(i, "");
                if (!packageName.isEmpty()) {
                    runningPackageNames.add(packageName);
                }
            }
        }

        // 5) Build a list of ThirdPartyCloudApp objects from installedApps
        List<ThirdPartyCloudApp> appList = new ArrayList<>();
        if (installedApps != null) {
            for (int i = 0; i < installedApps.length(); i++) {
                JSONObject appJson = installedApps.optJSONObject(i);
                if (appJson != null) {
                    // Extract packageName first so we can check isRunning
                    String packageName = appJson.optString("packageName", "unknown.package");

                    // Check if package is in runningPackageNames
                    boolean isRunning = runningPackageNames.contains(packageName);

                    // Create the ThirdPartyCloudApp
                    ThirdPartyCloudApp app = new ThirdPartyCloudApp(
                            packageName,
                            appJson.optString("name", "Unknown App"),
                            appJson.optString("description", "No description available."),
                            appJson.optString("webhookURL", ""),
                            appJson.optString("logoURL", ""),
                            isRunning
                    );
                    appList.add(app);
                }
            }
        }

        return appList;
    }

    // ------------------------------------------------------------------------
    // AUDIO QUEUE SENDER THREAD (IMPROVED)
    // ------------------------------------------------------------------------
    private void startAudioSenderThread() {
        // Don't start the audio thread if already running
        if (audioSenderThread != null) return;

        audioSenderRunning = true;
        audioSenderThread = new Thread(() -> {
            while (audioSenderRunning) {
                try {
                    // First check if we're connected before taking from queue
                    if (wsManager.isConnected()) {
                        if (isReconnecting) {
                            // On reconnection, drain the sliding buffer first
                            sendSlidingBufferAudio();
                            isReconnecting = false;
                        }

                        // Use poll with a long timeout instead of take() to remain responsive to shutdown
                        byte[] chunk = liveAudioQueue.poll(250, TimeUnit.MILLISECONDS);
                        if (chunk != null) {
                            wsManager.sendBinary(chunk);
                            // Write to PCM file whenever we send binary data over websocket
//                            writeToPcmFile(chunk);
                        }
                        // If poll times out (1 second with no data), we'll loop back and check conditions again
                    } else {
                        // If not connected, just sleep
                        Thread.sleep(250);
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        }, "AudioSenderThread");
        audioSenderThread.setDaemon(true);
        audioSenderThread.start();

        Log.d(TAG, "Started audio sender thread");
    }

    private void stopAudioSenderThread() {
        audioSenderRunning = false;
        if (audioSenderThread != null) {
            audioSenderThread.interrupt();
            audioSenderThread = null;
        }
    }

    public void cleanup() {
        wsManager.cleanup();
        disconnectWebSocket();
    }

    // Helper to get the backend server URL, with placeholder for custom URL logic
    private String getServerUrlForRest() {
        // TODO: If you want to support a custom backend URL (like the TSX module),
        // you could load it from SharedPreferences or another config here.
        // For now, use the default logic:
        String host = BuildConfig.AUGMENTOS_HOST;
        String port = BuildConfig.AUGMENTOS_PORT;
        boolean secureServer = Boolean.parseBoolean(BuildConfig.AUGMENTOS_SECURE);
        return String.format("%s://%s:%s", secureServer ? "https" : "http", host, port);
    }

    // Add this method to send user datetime to backend
    public void sendUserDatetimeToBackend(String userId, String isoDatetime) {
        try {
            String baseUrl = getServerUrlForRest();
            String url = baseUrl + "/api/user-data/set-datetime";

            JSONObject body = new JSONObject();
            body.put("userId", userId);
            body.put("datetime", isoDatetime);

            RequestBody requestBody = RequestBody.create(
                body.toString(), okhttp3.MediaType.get("application/json; charset=utf-8")
            );
            Request request = new Request.Builder()
                .url(url)
                .post(requestBody)
                .build();

            Log.d(TAG, "Sending datetime to backend: " + url);
            OkHttpClient client = new OkHttpClient();
            client.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.e(TAG, "Failed to send datetime to backend: " + e.getMessage());
                }
                @Override
                public void onResponse(Call call, Response response) throws IOException {
                    if (response.isSuccessful()) {
                        Log.d(TAG, "Datetime sent to backend successfully: " + response.body().string());
                    } else {
                        Log.e(TAG, "Failed to send datetime to backend. Response: " + response.code() + ", " + response.body().string());
                    }
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Exception while sending datetime to backend: " + e.getMessage());
        }
    }
}