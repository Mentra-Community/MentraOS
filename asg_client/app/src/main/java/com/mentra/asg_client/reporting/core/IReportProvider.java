package com.mentra.asg_client.reporting.core;

/**
 * Interface defining the contract for all reporting providers
 * Follows Interface Segregation Principle - only essential methods
 */
public interface IReportProvider {
    
    /**
     * Initialize the reporting provider
     * @param context Application context
     * @return true if initialization was successful
     */
    boolean initialize(android.content.Context context);
    
    /**
     * Report data to the provider
     * @param reportData The data to report
     */
    void report(ReportData reportData);
    
    /**
     * Set user context for all future reports
     * @param userId User identifier
     * @param username User display name
     * @param email User email
     */
    void setUserContext(String userId, String username, String email);
    
    /**
     * Clear user context
     */
    void clearUserContext();
    
    /**
     * Add breadcrumb for debugging
     * @param message Breadcrumb message
     * @param category Breadcrumb category
     * @param level Breadcrumb level
     */
    void addBreadcrumb(String message, String category, ReportLevel level);
    
    /**
     * Check if the provider is enabled
     * @return true if enabled
     */
    boolean isEnabled();
    
    /**
     * Enable or disable the provider
     * @param enabled true to enable, false to disable
     */
    void setEnabled(boolean enabled);
    
    /**
     * Get the provider name
     * @return Provider name
     */
    String getProviderName();
} 