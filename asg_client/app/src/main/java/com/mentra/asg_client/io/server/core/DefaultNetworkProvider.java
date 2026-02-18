package com.mentra.asg_client.io.server.core;

import com.mentra.asg_client.io.server.interfaces.NetworkProvider;
import com.mentra.asg_client.logging.Logger;

import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;

/**
 * Default implementation of NetworkProvider for Android.
 * Follows Single Responsibility Principle by handling only network information.
 */
public class DefaultNetworkProvider implements NetworkProvider {
    private final Logger logger;
    
    public DefaultNetworkProvider(Logger logger) {
        this.logger = logger;
    }
    
    @Override
    public String getBestIpAddress() {
        try {
            String[] allIps = getAllIpAddresses();
            if (allIps.length == 0) {
                logger.warn("NetworkProvider", "No network interfaces found");
                return "127.0.0.1";
            }
            
            // Prefer non-loopback addresses
            for (String ip : allIps) {
                if (!ip.equals("127.0.0.1") && !ip.equals("::1")) {
                    logger.debug("NetworkProvider", "Selected best IP: " + ip);
                    return ip;
                }
            }
            
            // Fallback to first available
            logger.debug("NetworkProvider", "Using fallback IP: " + allIps[0]);
            return allIps[0];
            
        } catch (Exception e) {
            logger.error("NetworkProvider", "Error getting best IP address", e);
            return "127.0.0.1";
        }
    }
    
    @Override
    public String[] getAllIpAddresses() {
        List<String> ipAddresses = new ArrayList<>();
        
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            
            while (interfaces.hasMoreElements()) {
                NetworkInterface networkInterface = interfaces.nextElement();
                
                // Skip loopback and down interfaces
                if (networkInterface.isLoopback() || !networkInterface.isUp()) {
                    continue;
                }
                
                Enumeration<InetAddress> addresses = networkInterface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    String ip = address.getHostAddress();
                    
                    // Skip IPv6 addresses for simplicity
                    if (ip.contains(":")) {
                        continue;
                    }
                    
                    ipAddresses.add(ip);
                    logger.debug("NetworkProvider", 
                               String.format("Found IP: %s on interface: %s", 
                                           ip, networkInterface.getDisplayName()));
                }
            }
            
        } catch (SocketException e) {
            logger.error("NetworkProvider", "Error enumerating network interfaces", e);
        }
        
        if (ipAddresses.isEmpty()) {
            logger.warn("NetworkProvider", "No valid IP addresses found, adding localhost");
            ipAddresses.add("127.0.0.1");
        }
        
        return ipAddresses.toArray(new String[0]);
    }
    
    @Override
    public boolean isNetworkAvailable() {
        try {
            String[] ips = getAllIpAddresses();
            boolean hasNonLoopback = false;
            
            for (String ip : ips) {
                if (!ip.equals("127.0.0.1") && !ip.equals("::1")) {
                    hasNonLoopback = true;
                    break;
                }
            }
            
            logger.debug("NetworkProvider", 
                        String.format("Network available: %s (found %d IPs)", 
                                    hasNonLoopback, ips.length));
            return hasNonLoopback;
            
        } catch (Exception e) {
            logger.error("NetworkProvider", "Error checking network availability", e);
            return false;
        }
    }
    
    @Override
    public String getNetworkInterfaceName() {
        try {
            String bestIp = getBestIpAddress();
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            
            while (interfaces.hasMoreElements()) {
                NetworkInterface networkInterface = interfaces.nextElement();
                
                if (networkInterface.isLoopback() || !networkInterface.isUp()) {
                    continue;
                }
                
                Enumeration<InetAddress> addresses = networkInterface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (address.getHostAddress().equals(bestIp)) {
                        String name = networkInterface.getDisplayName();
                        logger.debug("NetworkProvider", 
                                   String.format("Network interface for %s: %s", bestIp, name));
                        return name;
                    }
                }
            }
            
        } catch (SocketException e) {
            logger.error("NetworkProvider", "Error getting network interface name", e);
        }
        
        return "unknown";
    }
} 