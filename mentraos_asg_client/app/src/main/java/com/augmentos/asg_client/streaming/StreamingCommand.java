package com.augmentos.asg_client.streaming;

/**
 * Commands that can be sent to the RtmpStreamingService
 */
public abstract class StreamingCommand {
    
    /**
     * Command to start streaming
     */
    public static class Start extends StreamingCommand {}
    
    /**
     * Command to stop streaming
     */
    public static class Stop extends StreamingCommand {}
    
    /**
     * Command to set the RTMP URL
     */
    public static class SetRtmpUrl extends StreamingCommand {
        private final String rtmpUrl;
        
        public SetRtmpUrl(String rtmpUrl) {
            this.rtmpUrl = rtmpUrl;
        }
        
        public String getRtmpUrl() {
            return rtmpUrl;
        }
    }

    /**
     * Command to launch the streaming activity
     */
    public static class LaunchActivity extends StreamingCommand {
        private final String rtmpUrl;

        public LaunchActivity(String rtmpUrl) {
            this.rtmpUrl = rtmpUrl;
        }

        public String getRtmpUrl() {
            return rtmpUrl;
        }
    }
    
    /**
     * Command to switch camera (front/back)
     */
    public static class SwitchCamera extends StreamingCommand {}
    
    /**
     * Command to toggle flash
     */
    public static class ToggleFlash extends StreamingCommand {}
    
    /**
     * Command to mute/unmute audio
     */
    public static class SetMute extends StreamingCommand {
        private final boolean mute;
        
        public SetMute(boolean mute) {
            this.mute = mute;
        }
        
        public boolean isMute() {
            return mute;
        }
    }
}