package com.mentra.asg_client.reporting.core;

import android.content.Context;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Main report manager that orchestrates all reporting providers
 * Follows Dependency Inversion Principle - depends on abstractions, not concretions
 * Follows Single Responsibility Principle - only manages reporting
 */
public class ReportManager {
    
    private static final String TAG = "ReportManager";
    private static ReportManager instance;
    
    private final List<IReportProvider> providers;
    private final ExecutorService executor;
    private final Context context;
    private String currentUserId;
    private String currentUsername;
    private String currentEmail;
    private String currentSessionId;
    
    private ReportManager(Context context) {
        this.context = context.getApplicationContext();
        this.providers = new ArrayList<>();
        this.executor = Executors.newCachedThreadPool();
    }
    
    /**
     * Get singleton instance
     */
    public static synchronized ReportManager getInstance(Context context) {
        if (instance == null) {
            instance = new ReportManager(context);
        }
        return instance;
    }
    
    /**
     * Add a report provider
     */
    public void addProvider(IReportProvider provider) {
        if (provider == null) {
            Log.w(TAG, "Cannot add null provider");
            return;
        }
        
        try {
            boolean initialized = provider.initialize(context);
            if (initialized) {
                providers.add(provider);
                Log.i(TAG, "Provider added: " + provider.getProviderName());
                
                // Set current user context if available
                if (currentUserId != null) {
                    provider.setUserContext(currentUserId, currentUsername, currentEmail);
                }
            } else {
                Log.e(TAG, "Failed to initialize provider: " + provider.getProviderName());
            }
        } catch (Exception e) {
            Log.e(TAG, "Error adding provider: " + provider.getProviderName(), e);
        }
    }
    
    /**
     * Remove a report provider
     */
    public void removeProvider(IReportProvider provider) {
        if (provider != null && providers.remove(provider)) {
            Log.i(TAG, "Provider removed: " + provider.getProviderName());
        }
    }
    
    /**
     * Remove provider by name
     */
    public void removeProvider(String providerName) {
        providers.removeIf(provider -> {
            if (provider.getProviderName().equals(providerName)) {
                Log.i(TAG, "Provider removed: " + providerName);
                return true;
            }
            return false;
        });
    }
    
    /**
     * Get provider by name
     */
    public IReportProvider getProvider(String providerName) {
        for (IReportProvider provider : providers) {
            if (provider.getProviderName().equals(providerName)) {
                return provider;
            }
        }
        return null;
    }
    
    /**
     * Report data to all enabled providers
     */
    public void report(ReportData reportData) {
        if (reportData == null) {
            Log.w(TAG, "Cannot report null data");
            return;
        }
        
        // Add current user and session info if not already set
        ReportData.Builder builder = new ReportData.Builder()
            .message(reportData.getMessage())
            .level(reportData.getLevel())
            .category(reportData.getCategory())
            .operation(reportData.getOperation())
            .tags(reportData.getTags())
            .context(reportData.getContext())
            .exception(reportData.getException())
            .timestamp(reportData.getTimestamp());
        
        if (reportData.getUserId() == null && currentUserId != null) {
            builder.userId(currentUserId);
        } else {
            builder.userId(reportData.getUserId());
        }
        
        if (reportData.getSessionId() == null && currentSessionId != null) {
            builder.sessionId(currentSessionId);
        } else {
            builder.sessionId(reportData.getSessionId());
        }
        
        ReportData enhancedData = builder.build();
        
        // Apply central data filtering to all reports
        ReportData filteredData = DataFilter.filterReportData(enhancedData);
        
        // Report to all enabled providers asynchronously
        executor.execute(() -> {
            for (IReportProvider provider : providers) {
                if (provider.isEnabled()) {
                    try {
                        provider.report(filteredData);
                    } catch (Exception e) {
                        Log.e(TAG, "Error reporting to " + provider.getProviderName(), e);
                    }
                }
            }
        });
    }
    
    /**
     * Convenience method for reporting with builder pattern
     */
    public void report(ReportData.Builder builder) {
        report(builder.build());
    }

    /**
     * Report data synchronously to all enabled providers.
     * Use this for critical reports (like crashes) that must complete before the app dies.
     * This blocks the calling thread until all providers have processed the report.
     */
    public void reportSync(ReportData reportData) {
        if (reportData == null) {
            Log.w(TAG, "Cannot report null data");
            return;
        }

        // Add current user and session info if not already set
        ReportData.Builder builder = new ReportData.Builder()
            .message(reportData.getMessage())
            .level(reportData.getLevel())
            .category(reportData.getCategory())
            .operation(reportData.getOperation())
            .tags(reportData.getTags())
            .context(reportData.getContext())
            .exception(reportData.getException())
            .timestamp(reportData.getTimestamp());

        if (reportData.getUserId() == null && currentUserId != null) {
            builder.userId(currentUserId);
        } else {
            builder.userId(reportData.getUserId());
        }

        if (reportData.getSessionId() == null && currentSessionId != null) {
            builder.sessionId(currentSessionId);
        } else {
            builder.sessionId(reportData.getSessionId());
        }

        ReportData enhancedData = builder.build();

        // Apply central data filtering to all reports
        ReportData filteredData = DataFilter.filterReportData(enhancedData);

        // Report to all enabled providers SYNCHRONOUSLY
        for (IReportProvider provider : providers) {
            if (provider.isEnabled()) {
                try {
                    provider.report(filteredData);
                } catch (Exception e) {
                    Log.e(TAG, "Error reporting to " + provider.getProviderName(), e);
                }
            }
        }
    }
    
    /**
     * Set user context for all providers
     */
    public void setUserContext(String userId, String username, String email) {
        // Apply central data filtering to user context
        DataFilter.UserInfo filteredUserInfo = DataFilter.filterUserInfo(userId, username, email);
        
        this.currentUserId = filteredUserInfo.userId();
        this.currentUsername = filteredUserInfo.username();
        this.currentEmail = filteredUserInfo.email();
        
        for (IReportProvider provider : providers) {
            if (provider.isEnabled()) {
                try {
                    provider.setUserContext(filteredUserInfo.userId(),
                                          filteredUserInfo.username(),
                                          filteredUserInfo.email());
                } catch (Exception e) {
                    Log.e(TAG, "Error setting user context for " + provider.getProviderName(), e);
                }
            }
        }
        
        Log.i(TAG, "User context set for all providers: " + filteredUserInfo.userId());
    }
    
    /**
     * Clear user context for all providers
     */
    public void clearUserContext() {
        this.currentUserId = null;
        this.currentUsername = null;
        this.currentEmail = null;
        
        for (IReportProvider provider : providers) {
            if (provider.isEnabled()) {
                try {
                    provider.clearUserContext();
                } catch (Exception e) {
                    Log.e(TAG, "Error clearing user context for " + provider.getProviderName(), e);
                }
            }
        }
        
        Log.i(TAG, "User context cleared for all providers");
    }
    
    /**
     * Add breadcrumb to all providers
     */
    public void addBreadcrumb(String message, String category, ReportLevel level) {
        for (IReportProvider provider : providers) {
            if (provider.isEnabled()) {
                try {
                    provider.addBreadcrumb(message, category, level);
                } catch (Exception e) {
                    Log.e(TAG, "Error adding breadcrumb to " + provider.getProviderName(), e);
                }
            }
        }
    }
    
    /**
     * Set session ID for future reports
     */
    public void setSessionId(String sessionId) {
        this.currentSessionId = sessionId;
        Log.i(TAG, "Session ID set: " + sessionId);
    }
    
    /**
     * Enable/disable a specific provider
     */
    public void setProviderEnabled(String providerName, boolean enabled) {
        IReportProvider provider = getProvider(providerName);
        if (provider != null) {
            provider.setEnabled(enabled);
        } else {
            Log.w(TAG, "Provider not found: " + providerName);
        }
    }
    
    /**
     * Get all provider names
     */
    public List<String> getProviderNames() {
        List<String> names = new ArrayList<>();
        for (IReportProvider provider : providers) {
            names.add(provider.getProviderName());
        }
        return names;
    }
    
    /**
     * Get enabled provider names
     */
    public List<String> getEnabledProviderNames() {
        List<String> names = new ArrayList<>();
        for (IReportProvider provider : providers) {
            if (provider.isEnabled()) {
                names.add(provider.getProviderName());
            }
        }
        return names;
    }
    
    /**
     * Shutdown the report manager
     */
    public void shutdown() {
        executor.shutdown();
        Log.i(TAG, "Report manager shutdown");
    }
    
    /**
     * Get current user ID
     */
    public String getCurrentUserId() {
        return currentUserId;
    }
    
    /**
     * Get current session ID
     */
    public String getCurrentSessionId() {
        return currentSessionId;
    }
} 