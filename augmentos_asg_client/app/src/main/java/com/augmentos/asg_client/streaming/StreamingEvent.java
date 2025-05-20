package com.augmentos.asg_client.streaming;

/**
 * Events emitted by the RtmpStreamingService
 */
public abstract class StreamingEvent {
    
    /**
     * Emitted when the streamer is ready to be used
     */
    public static class Ready extends StreamingEvent {}
    
    /**
     * Emitted when the preview is successfully attached
     */
    public static class PreviewAttached extends StreamingEvent {}
    
    /**
     * Emitted when streaming starts
     */
    public static class Started extends StreamingEvent {}
    
    /**
     * Emitted when streaming stops
     */
    public static class Stopped extends StreamingEvent {}
    
    /**
     * Emitted when RTMP connection is established
     */
    public static class Connected extends StreamingEvent {}
    
    /**
     * Emitted when RTMP connection fails
     */
    public static class ConnectionFailed extends StreamingEvent {
        private final String message;
        
        public ConnectionFailed(String message) {
            this.message = message;
        }
        
        public String getMessage() {
            return message;
        }
    }
    
    /**
     * Emitted when RTMP connection is disconnected
     */
    public static class Disconnected extends StreamingEvent {}
    
    /**
     * Emitted when an error occurs
     */
    public static class Error extends StreamingEvent {
        private final String message;
        
        public Error(String message) {
            this.message = message;
        }
        
        public String getMessage() {
            return message;
        }
    }
}