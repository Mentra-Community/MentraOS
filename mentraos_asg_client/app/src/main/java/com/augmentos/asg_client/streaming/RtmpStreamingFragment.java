package com.augmentos.asg_client.streaming;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.IBinder;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;

import com.augmentos.asg_client.R;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;

import io.github.thibaultbee.streampack.views.PreviewView;

/**
 * Fragment that demonstrates RTMP streaming using StreamPackLite
 */
public class RtmpStreamingFragment extends Fragment {
    private static final String TAG = "RtmpStreamingFragment";
    
    private PreviewView mPreviewView;
    private Button mButtonStartStop;
    private Button mButtonSwitchCamera;
    private Button mButtonToggleFlash;
    private EditText mEditTextRtmpUrl;
    private TextView mTextViewStatus;
    
    private RtmpStreamingService mStreamingService;
    private boolean mBound = false;
    
    private final ServiceConnection mConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName className, IBinder service) {
            RtmpStreamingService.LocalBinder binder = (RtmpStreamingService.LocalBinder) service;
            mStreamingService = binder.getService();
            mBound = true;
            
            // Service connected, attach preview and update UI
            mStreamingService.attachPreview(mPreviewView);
            updateButtonStates();
        }

        @Override
        public void onServiceDisconnected(ComponentName componentName) {
            mBound = false;
            mStreamingService = null;
        }
    };
    
    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        View view = inflater.inflate(R.layout.fragment_rtmp_streaming, container, false);
        
        // Initialize views
        mPreviewView = view.findViewById(R.id.preview);
        mButtonStartStop = view.findViewById(R.id.buttonStartStop);
        mButtonSwitchCamera = view.findViewById(R.id.buttonSwitchCamera);
        mButtonToggleFlash = view.findViewById(R.id.buttonToggleFlash);
        mEditTextRtmpUrl = view.findViewById(R.id.editTextRtmpUrl);
        mTextViewStatus = view.findViewById(R.id.textViewStatus);
        
        // Set up button click listeners
        mButtonStartStop.setOnClickListener(v -> toggleStreaming());
        mButtonSwitchCamera.setOnClickListener(v -> switchCamera());
        mButtonToggleFlash.setOnClickListener(v -> toggleFlash());
        
        return view;
    }
    
    @Override
    public void onStart() {
        super.onStart();
        // Register for EventBus events
        if (!EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().register(this);
        }
        
        // Bind to the streaming service
        Intent intent = new Intent(getContext(), RtmpStreamingService.class);
        getContext().bindService(intent, mConnection, Context.BIND_AUTO_CREATE);
        getContext().startService(intent);
    }
    
    @Override
    public void onStop() {
        super.onStop();
        // Unregister from EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
        }
        
        // Unbind from service
        if (mBound) {
            getContext().unbindService(mConnection);
            mBound = false;
        }
    }
    
    /**
     * Toggle streaming on/off
     */
    private void toggleStreaming() {
        if (mBound && mStreamingService != null) {
            if (mStreamingService.isStreaming()) {
                // Stop streaming
                EventBus.getDefault().post(new StreamingCommand.Stop());
            } else {
                // Start streaming - first validate and set RTMP URL
                String rtmpUrl = mEditTextRtmpUrl.getText().toString().trim();
                if (rtmpUrl.isEmpty()) {
                    Toast.makeText(getContext(), "Please enter an RTMP URL", Toast.LENGTH_SHORT).show();
                    return;
                }
                
                EventBus.getDefault().post(new StreamingCommand.SetRtmpUrl(rtmpUrl));
                EventBus.getDefault().post(new StreamingCommand.Start());
            }
        }
    }
    
    /**
     * Switch between front and back cameras
     */
    private void switchCamera() {
        if (mBound && mStreamingService != null) {
            EventBus.getDefault().post(new StreamingCommand.SwitchCamera());
        }
    }
    
    /**
     * Toggle flash on/off
     */
    private void toggleFlash() {
        if (mBound && mStreamingService != null) {
            EventBus.getDefault().post(new StreamingCommand.ToggleFlash());
        }
    }
    
    /**
     * Update button states based on current streaming state
     */
    private void updateButtonStates() {
        if (mBound && mStreamingService != null) {
            boolean isStreaming = mStreamingService.isStreaming();
            mButtonStartStop.setText(isStreaming ? "Stop Streaming" : "Start Streaming");
            mEditTextRtmpUrl.setEnabled(!isStreaming);
        }
    }
    
    /**
     * Handle streaming events from the service
     */
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onStreamingEvent(StreamingEvent event) {
        if (event instanceof StreamingEvent.Ready) {
            mTextViewStatus.setText("Status: Ready");
        } else if (event instanceof StreamingEvent.Started) {
            mTextViewStatus.setText("Status: Started");
            updateButtonStates();
        } else if (event instanceof StreamingEvent.Stopped) {
            mTextViewStatus.setText("Status: Stopped");
            updateButtonStates();
        } else if (event instanceof StreamingEvent.Connected) {
            mTextViewStatus.setText("Status: Connected");
        } else if (event instanceof StreamingEvent.Disconnected) {
            mTextViewStatus.setText("Status: Disconnected");
        } else if (event instanceof StreamingEvent.ConnectionFailed) {
            String message = ((StreamingEvent.ConnectionFailed) event).getMessage();
            mTextViewStatus.setText("Status: Connection Failed");
            Toast.makeText(getContext(), "Connection failed: " + message, Toast.LENGTH_SHORT).show();
            updateButtonStates();
        } else if (event instanceof StreamingEvent.Error) {
            String message = ((StreamingEvent.Error) event).getMessage();
            mTextViewStatus.setText("Status: Error");
            Toast.makeText(getContext(), "Error: " + message, Toast.LENGTH_SHORT).show();
        }
    }
}