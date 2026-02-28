package com.mentra.asg_client.io.server.core;

import android.content.Context;
import com.mentra.asg_client.io.server.interfaces.ServerConfig;

/**
 * Default implementation of ServerConfig.
 * Follows Single Responsibility Principle by handling only configuration.
 */
public class DefaultServerConfig implements ServerConfig {
    private final int port;
    private final String serverName;
    private final int maxRequestSize;
    private final int requestTimeout;
    private final boolean corsEnabled;
    private final String[] allowedOrigins;
    private final Context context;
    
    public DefaultServerConfig(int port, String serverName, int maxRequestSize, 
                              int requestTimeout, boolean corsEnabled, String[] allowedOrigins, Context context) {
        this.port = port;
        this.serverName = serverName;
        this.maxRequestSize = maxRequestSize;
        this.requestTimeout = requestTimeout;
        this.corsEnabled = corsEnabled;
        this.allowedOrigins = allowedOrigins != null ? allowedOrigins.clone() : new String[0];
        this.context = context;
    }
    
    @Override
    public int getPort() {
        return port;
    }
    
    @Override
    public String getServerName() {
        return serverName;
    }
    
    @Override
    public int getMaxRequestSize() {
        return maxRequestSize;
    }
    
    @Override
    public int getRequestTimeout() {
        return requestTimeout;
    }
    
    @Override
    public boolean isCorsEnabled() {
        return corsEnabled;
    }
    
    @Override
    public String[] getAllowedOrigins() {
        return allowedOrigins.clone();
    }
    
    @Override
    public Context getContext() {
        return context;
    }
    
    /**
     * Builder for creating DefaultServerConfig instances
     */
    public static class Builder {
        private int port = 8089;
        private String serverName = "ASG Server";
        private int maxRequestSize = 1024 * 1024; // 1MB
        private int requestTimeout = 600000; // 10 minutes for large video transfers (was 30 seconds)
        private boolean corsEnabled = true;
        private String[] allowedOrigins = {"*"};
        private Context context;
        
        public Builder port(int port) {
            this.port = port;
            return this;
        }
        
        public Builder serverName(String serverName) {
            this.serverName = serverName;
            return this;
        }
        
        public Builder maxRequestSize(int maxRequestSize) {
            this.maxRequestSize = maxRequestSize;
            return this;
        }
        
        public Builder requestTimeout(int requestTimeout) {
            this.requestTimeout = requestTimeout;
            return this;
        }
        
        public Builder corsEnabled(boolean corsEnabled) {
            this.corsEnabled = corsEnabled;
            return this;
        }
        
        public Builder allowedOrigins(String[] allowedOrigins) {
            this.allowedOrigins = allowedOrigins;
            return this;
        }
        
        public Builder context(Context context) {
            this.context = context;
            return this;
        }
        
        public DefaultServerConfig build() {
            return new DefaultServerConfig(port, serverName, maxRequestSize, 
                                         requestTimeout, corsEnabled, allowedOrigins, context);
        }
    }
} 