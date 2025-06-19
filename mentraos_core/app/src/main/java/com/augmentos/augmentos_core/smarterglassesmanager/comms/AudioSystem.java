package com.augmentos.augmentos_core.smarterglassesmanager.comms;

import android.media.AudioFormat;

import android.util.Base64;

import io.reactivex.rxjava3.disposables.Disposable;
import io.reactivex.rxjava3.subjects.PublishSubject;

import java.io.IOException;

import org.json.JSONObject;
import org.json.JSONException;

import android.content.Context;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.nio.ByteOrder;

import android.os.Handler;
import android.os.HandlerThread;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.io.DataOutputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.io.DataInputStream;
import java.net.ServerSocket;
import java.net.Socket;

import android.util.Log;

import com.augmentos.augmentos_core.R;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.AudioChunkNewEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.hci.AudioProcessingCallback;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.AES;

/**
 * Audio system for handling audio data transmission and reception
 * BATTERY OPTIMIZATION: Uses direct callbacks instead of EventBus for high-frequency audio events
 */
public class AudioSystem {
    private static String TAG = "WearableAi_AudioSystem";

    private boolean shouldDie;

    private String secretKey;

    // the audio recording options - same on ASG
    private static final int RECORDING_RATE = 16000;
    private static final int CHANNEL = AudioFormat.CHANNEL_IN_MONO;
    private static final int FORMAT = AudioFormat.ENCODING_PCM_16BIT;

    // Socket info
    static int PORT = 4449;
    private static int mConnectState = 0;
    final byte [] ack_id = {0x13, 0x37};
    final byte [] heart_beat_id = {0x19, 0x20};
    final byte [] img_id = {0x01, 0x10}; //id for images

    // Heart beat stuff
    private static long lastHeartbeatTime;
    private static int heartbeatInterval = 3000; //milliseconds
    private static int heartbeatPanicX = 3; // number of intervals before we reset connection
    static Thread HeartbeatThread = null;
    private  int outbound_heart_beats = 0;

    // Socket data
    static Thread SocketThread = null;
    static Thread ReceiveThread = null;
    static Thread SendThread = null;
    // I/O
    private  DataOutputStream output;
    private  DataInputStream input;

    // Socket connection objects
    ServerSocket serverSocket;
    private static Socket socket;

    // Subject for data communication
    PublishSubject<JSONObject> dataObservable;
    Disposable dataSubscriber;

    // Context
    Context context;
    
    // BATTERY OPTIMIZATION: Added direct callback for audio processing
    private final List<AudioProcessingCallback> audioProcessingCallbacks = new ArrayList<>();

    /**
     * Create a new AudioSystem
     * @param context The application context
     * @param dataObservable The observable for JSON data communication
     */
    public AudioSystem(Context context, PublishSubject<JSONObject> dataObservable){
        this.context = context;

        // Set the key for encryption
        secretKey = context.getResources().getString(R.string.key);

        this.dataObservable = dataObservable;
        dataSubscriber = dataObservable.subscribe(i -> handleDataStream(i));
    }

    /**
     * BATTERY OPTIMIZATION: Register a callback for audio processing
     * @param callback The callback to register
     */
    public void registerAudioProcessingCallback(AudioProcessingCallback callback) {
        if (callback != null && !audioProcessingCallbacks.contains(callback)) {
            audioProcessingCallbacks.add(callback);
        }
    }

    /**
     * BATTERY OPTIMIZATION: Unregister a callback for audio processing
     * @param callback The callback to unregister
     */
    public void unregisterAudioProcessingCallback(AudioProcessingCallback callback) {
        if (callback != null) {
            audioProcessingCallbacks.remove(callback);
        }
    }

    // Send queue of data to send through the socket
    private  BlockingQueue<byte []> send_queue;

    public void startAudio(){
        // Make a new queue to hold data to send
        send_queue = new ArrayBlockingQueue<byte[]>(50);

        // Start the socket thread which will send the raw audio data
        startSocket();
    }

    public void startSocket(){
        // Start first socketThread
        if (socket == null) {
            mConnectState = 1;
            SocketThread = new Thread(new SocketThread(), "SocketThread");
            SocketThread.start();

            // Setup handler to handle keeping connection alive, all subsequent start of SocketThread
            // Start a new handler thread to send heartbeats
            HandlerThread thread = new HandlerThread("HeartBeater");
            thread.start();
            Handler heart_beat_handler = new Handler(thread.getLooper());
            final int hb_delay = 3000;
            final int min_hb_delay = 1000;
            final int max_hb_delay = 2000;
            Random rand = new Random();
            heart_beat_handler.postDelayed(new Runnable() {
                public void run() {
                    heartBeat();
                    // Random hb_delay for heart beat to disallow synchronized failure between client and server
                    int random_hb_delay = rand.nextInt((max_hb_delay - min_hb_delay) + 1) + min_hb_delay;
                    heart_beat_handler.postDelayed(this, random_hb_delay);
                }
            }, hb_delay);
        }
    }

    private void heartBeat(){
        // Check if we are still connected.
        // If not, reconnect.
        // If we are connected, send a heart beat to make sure we are still connected
        if ((mConnectState == 0) && (shouldDie == false)) {
            restartSocket();
        } else if (mConnectState == 2){
            // Implement heart beat logic if needed
            // Currently not implemented for ASG
        }
    }

    private void restartSocket(){
        Log.d(TAG, "Running restart socket");
        mConnectState = 1;

        outbound_heart_beats = 0;

        // Close the previous socket now that it's broken/being restarted
        killSocket();

        // Make sure socket thread has joined before throwing off a new one
        try {
            Log.d(TAG, "Waiting socket thread join");
            SocketThread.join();
            Log.d(TAG, "Socket thread joined");
        } catch (InterruptedException e){
            e.printStackTrace();
        }

        // Start a new socket thread
        SocketThread = new Thread(new SocketThread(), "RestartSocketThread");
        SocketThread.start();
    }

    private void killSocket(){
        try {
            if (serverSocket != null && (!serverSocket.isClosed())) {
                Log.d(TAG, "Closing socket, input, serverSocket, etc.");
                serverSocket.close();
            }
            if (socket != null){
                socket.close();
            }
            if (output != null){
                output.close();
            }
            if (input != null){
                input.close();
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    class SocketThread implements Runnable {
        @Override
        public void run() {
            try {
                Log.d(TAG, "Starting new socket, waiting for connection...");
                serverSocket = new ServerSocket(PORT);
                try {
                    socket = serverSocket.accept();
                    socket.setSoTimeout(3000);
                    Log.d(TAG, "Got socket connection.");
                    //output = new PrintWriter(socket.getOutputStream(), true);
                    output = new DataOutputStream(socket.getOutputStream());
                    input = new DataInputStream(new DataInputStream(socket.getInputStream()));
                    mConnectState = 2;
                    if (ReceiveThread == null) { //if the thread is null, make a new one (the first one)
                        ReceiveThread = new Thread(new ReceiveThread(), "ReceiveThread");
                        ReceiveThread.start();
                    } else if (!ReceiveThread.isAlive()) { //if the thread is not null but it's dead, let it join then start a new one
                        try {
                            ReceiveThread.join(); //make sure socket thread has joined before throwing off a new one
                        } catch (InterruptedException e) {
                            e.printStackTrace();
                        }
                        ReceiveThread = new Thread(new ReceiveThread(), "ReceiveThread");
                        ReceiveThread.start();
                    }
                    if (SendThread == null) { //if the thread is null, make a new one (the first one)
                    SendThread = new Thread(new SendThread(), "SendThread");
                    SendThread.start();
                } else if (!SendThread.isAlive()) { //if the thread is not null but it's dead, let it join then start a new one
                    try {
                        SendThread.join(); //make sure socket thread has joined before throwing off a new one
                    } catch (InterruptedException e) {
                        e.printStackTrace();
                    }
                    SendThread =  new Thread(new SendThread(), "SendThread");
                    SendThread.start();
                }
                } catch (IOException e) {
                    e.printStackTrace();
                    mConnectState = 0;
                }
            } catch (IOException e) {
                e.printStackTrace();
                mConnectState = 0;
            }
        }
    }


    public void sendBytes(byte[] id, byte [] data){
        // First, send hello
        byte [] hello = {0x01, 0x02, 0x03};
        // Then send length of body
        byte[] len;
        if (data != null) {
             len = my_int_to_bb_be(data.length);
        } else {
            len = my_int_to_bb_be(0);
        }
        // Then send id of message type
        byte [] msg_id = id;
        // Then send data
        byte [] body = data;
        // Then send end tag - eventually make this unique to the image
        byte [] goodbye = {0x3, 0x2, 0x1};
        // Combine those into a payload
        ByteArrayOutputStream outputStream;
        try {
            outputStream = new ByteArrayOutputStream();
            outputStream.write(hello);
            outputStream.write(len);
            outputStream.write(msg_id);
            if (body != null) {
                outputStream.write(body);
            }
            outputStream.write(goodbye);
        } catch (IOException e){
            mConnectState = 0;
            return;
        }
        byte [] payload = outputStream.toByteArray();

        // Send it in a background thread
        send_queue.add(payload);
    }

    // This sends messages
    class SendThread implements Runnable {
        SendThread() {
        }
        @Override
        public void run() {
            send_queue.clear();
            while (true){
                if (mConnectState != 2){
                    break;
                }
                if (send_queue.size() > 10){
                    break;
                }
                byte [] data;
                try {
                    data = send_queue.take(); //block until there is something we can pull out to send
                } catch (InterruptedException e){
                    e.printStackTrace();
                    break;
                }
                try {
                    output.write(data);           // write the message
                } catch (IOException e) {
                    e.printStackTrace();
                    break;
                }
            }
            throwBrokenSocket();
        }
    }

    // Receives messages
    private class ReceiveThread implements Runnable {
        @Override
        public void run() {
            while (true) {
                if (mConnectState != 2){
                    break;
                }
                try {
                    int chunk_len = 6416; // Until we use a better protocol to specify start and end of packet, we need to match the number in asg
                    byte [] raw_data = new byte[chunk_len];
                    input.readFully(raw_data, 0, chunk_len); // Read the body
                    
                    // BATTERY OPTIMIZATION: Use direct callbacks instead of EventBus
                    notifyAudioCallbacks(raw_data);
                } catch (IOException e) {
                    Log.d(TAG, "Audio service receive thread broken.");
                    e.printStackTrace();
                    break;
                }
            }
            throwBrokenSocket();
        }
    }
    
    /**
     * BATTERY OPTIMIZATION: Notify registered callbacks about new audio data
     * This replaces EventBus.getDefault().post(new AudioChunkNewEvent(raw_data))
     * @param audioData The raw audio data
     */
    private void notifyAudioCallbacks(byte[] audioData) {
        if (audioProcessingCallbacks.isEmpty()) {
            return;
        }
        
        // Make a copy of the list to prevent concurrent modification issues
        List<AudioProcessingCallback> callbacksCopy = new ArrayList<>(audioProcessingCallbacks);
        for (AudioProcessingCallback callback : callbacksCopy) {
            if (callback != null) {
                callback.onAudioDataAvailable(audioData);
            }
        }
    }

    public byte[] my_int_to_bb_be(int myInteger){
        return ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(myInteger).array();
    }


    private void throwBrokenSocket(){
        if (mConnectState == 2){
            mConnectState = 0;
        }
    }

    public byte [] decryptBytes(byte [] input) {
        byte [] decryptedBytes = AES.decrypt(input, secretKey);
        return decryptedBytes;
    }

    /**
     * Clean up resources
     */
    public void destroy(){
        shouldDie = true;
        
        // Dispose of dataSubscriber
        if (dataSubscriber != null && !dataSubscriber.isDisposed()) {
            dataSubscriber.dispose();
            dataSubscriber = null;
        }
        
        // Clear audio processing callbacks
        audioProcessingCallbacks.clear();
        
        // Kill socket
        killSocket();
        
        // Clear context reference
        context = null;
    }

    private void handleDataStream(JSONObject data){
        try {
            String dataType = data.getString(MessageTypes.MESSAGE_TYPE_LOCAL);
            if (dataType.equals(MessageTypes.AUDIO_CHUNK_ENCRYPTED)) {
                handleEncryptedData(data);
            } else if (dataType.equals(MessageTypes.AUDIO_CHUNK_DECRYPTED)){
                String encodedPlainData = data.getString(MessageTypes.AUDIO_DATA);
                byte [] decodedPlainData = Base64.decode(encodedPlainData, Base64.DEFAULT);
                
                // BATTERY OPTIMIZATION: Use direct callbacks instead of EventBus
                notifyAudioCallbacks(decodedPlainData);
            }
        } catch (JSONException e){
            e.printStackTrace();
        }
    }

    // Here we decode, decrypt, then encode again. 
    private void handleEncryptedData(JSONObject data){
        try{
            String encodedData = data.getString(MessageTypes.AUDIO_DATA);
            byte [] decodedData = Base64.decode(encodedData, Base64.DEFAULT);
            byte [] plainData = decryptBytes(decodedData);
            
            // BATTERY OPTIMIZATION: Use direct callbacks instead of EventBus
            notifyAudioCallbacks(plainData);
        } catch (JSONException e){
            e.printStackTrace();
        }
    }
}
