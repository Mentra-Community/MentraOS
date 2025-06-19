package com.augmentos.asg_client.streaming;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.IBinder;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.augmentos.asg_client.R;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;

import io.github.thibaultbee.streampack.views.PreviewView;

public class StreamingActivity extends AppCompatActivity {
    private static final String TAG = "StreamingActivity";

    private PreviewView previewView;
    private Button toggleStreamButton;
    private TextView streamStatusTextView;

    private RtmpStreamingService streamingService;
    private boolean isServiceBound = false;
    private boolean isStreaming = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_streaming);

        // Initialize UI components
        previewView = findViewById(R.id.previewView);
        toggleStreamButton = findViewById(R.id.toggleStreamButton);
        streamStatusTextView = findViewById(R.id.streamStatusTextView);

        // Set up button click listener
        toggleStreamButton.setOnClickListener(v -> toggleStreaming());

        // Register with EventBus to receive streaming events
        if (!EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().register(this);
        }

        // Extract RTMP URL from intent if provided
        String rtmpUrl = getIntent().getStringExtra("rtmp_url");
        if (rtmpUrl != null && !rtmpUrl.isEmpty()) {
            Log.d(TAG, "Received RTMP URL: " + rtmpUrl);
        }

        // Bind to the streaming service
        Intent serviceIntent = new Intent(this, RtmpStreamingService.class);
        bindService(serviceIntent, serviceConnection, Context.BIND_AUTO_CREATE);
    }

    @Override
    protected void onDestroy() {
        // Unregister from EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
        }

        // Unbind from service
        if (isServiceBound) {
            unbindService(serviceConnection);
            isServiceBound = false;
        }

        super.onDestroy();
    }

    /**
     * Service connection for binding to RtmpStreamingService
     */
    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            RtmpStreamingService.LocalBinder binder = (RtmpStreamingService.LocalBinder) service;
            streamingService = binder.getService();
            isServiceBound = true;

            // Initialize the preview with the service's streamer
            if (streamingService != null) {
                Log.d(TAG, "Service bound, initializing preview");
                streamingService.attachPreview(previewView);

                // Check if RTMP URL was passed in intent
                String rtmpUrl = getIntent().getStringExtra("rtmp_url");
                if (rtmpUrl != null && !rtmpUrl.isEmpty()) {
                    streamingService.setRtmpUrl(rtmpUrl);
                }

                updateUI();
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            isServiceBound = false;
        }
    };

    /**
     * Toggle streaming start/stop
     */
    private void toggleStreaming() {
        if (streamingService != null) {
            if (isStreaming) {
                streamingService.stopStreaming();
            } else {
                streamingService.startStreaming();
            }
        } else {
            Log.e(TAG, "Service not bound, cannot toggle streaming");
            updateStatus("Service not connected");
        }
    }

    /**
     * Update UI elements based on current state
     */
    private void updateUI() {
        if (streamingService != null) {
            isStreaming = streamingService.isStreaming();

            if (isStreaming) {
                toggleStreamButton.setText("Stop Stream");
                updateStatus("Streaming");
            } else {
                toggleStreamButton.setText("Start Stream");
                updateStatus("Ready");
            }
        }
    }

    /**
     * Update status text display
     */
    private void updateStatus(String status) {
        if (streamStatusTextView != null) {
            streamStatusTextView.setText(status);
        }
    }

    /**
     * Handle streaming events from the service via EventBus
     */
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onStreamingEvent(StreamingEvent event) {
        if (event instanceof StreamingEvent.Ready) {
            updateStatus("Ready");
        } else if (event instanceof StreamingEvent.Started) {
            isStreaming = true;
            updateUI();
        } else if (event instanceof StreamingEvent.Stopped) {
            isStreaming = false;
            updateUI();
        } else if (event instanceof StreamingEvent.Connected) {
            updateStatus("Connected");
        } else if (event instanceof StreamingEvent.Disconnected) {
            updateStatus("Disconnected");
            isStreaming = false;
            updateUI();
        } else if (event instanceof StreamingEvent.Error) {
            updateStatus("Error: " + ((StreamingEvent.Error) event).getMessage());
            isStreaming = false;
            updateUI();
        }
    }
}