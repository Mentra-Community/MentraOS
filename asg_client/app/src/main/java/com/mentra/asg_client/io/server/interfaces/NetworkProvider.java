package com.mentra.asg_client.io.server.interfaces;

/**
 * Network information provider interface.
 * Follows Interface Segregation Principle by providing only network-related methods.
 */
public interface NetworkProvider {
    /**
     * Get the best available IP address for the server
     * @return IP address as string
     */
    String getBestIpAddress();
    
    /**
     * Get all available IP addresses
     * @return Array of IP addresses
     */
    String[] getAllIpAddresses();
    
    /**
     * Check if network is available
     * @return true if network is available
     */
    boolean isNetworkAvailable();
    
    /**
     * Get network interface name
     * @return Network interface name
     */
    String getNetworkInterfaceName();
} 