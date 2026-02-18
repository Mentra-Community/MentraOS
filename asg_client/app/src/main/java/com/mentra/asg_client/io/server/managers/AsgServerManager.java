package com.mentra.asg_client.io.server.managers;

import com.mentra.asg_client.io.server.core.AsgServer;
import com.mentra.asg_client.io.server.core.DefaultServerFactory;
import com.mentra.asg_client.io.server.interfaces.*;
import com.mentra.asg_client.logging.Logger;
import android.content.Context;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Centralized server manager following SOLID principles.
 * Single Responsibility: Server lifecycle and management
 * Open/Closed: Extensible through composition
 * Liskov Substitution: Uses interfaces
 * Interface Segregation: Specific interfaces for different concerns
 * Dependency Inversion: Depends on abstractions
 */
public class AsgServerManager {

    private static AsgServerManager instance;
    private final Context context;
    private final Logger logger;
    private final Map<String, AsgServer> servers = new ConcurrentHashMap<>();
    private final Map<String, ServerConfig> serverConfigs = new ConcurrentHashMap<>();

    /**
     * Private constructor with dependency injection.
     */
    private AsgServerManager(Context context, Logger logger) {
        this.context = context.getApplicationContext();
        this.logger = logger;
        
        logger.info("ServerManager", "🚀 =========================================");
        logger.info("ServerManager", "🚀 SERVER MANAGER INITIALIZED");
        logger.info("ServerManager", "🚀 =========================================");
    }

    /**
     * Get the singleton instance of ServerManager.
     */
    public static synchronized AsgServerManager getInstance(Context context) {
        if (instance == null) {
            Logger logger = DefaultServerFactory.createLogger();
            instance = new AsgServerManager(context, logger);
        }
        return instance;
    }

    /**
     * Register a server with configuration.
     */
    public void registerServer(String serverName, AsgServer server, ServerConfig config) {
        logger.info("ServerManager", "📝 =========================================");
        logger.info("ServerManager", "📝 REGISTERING SERVER");
        logger.info("ServerManager", "📝 =========================================");
        logger.info("ServerManager", "📝 📝 Server name: " + serverName);
        logger.info("ServerManager", "📝 📝 Server class: " + server.getClass().getSimpleName());
        logger.info("ServerManager", "📝 📝 Port: " + config.getPort());
        
        servers.put(serverName, server);
        serverConfigs.put(serverName, config);
        
        logger.info("ServerManager", "📝 ✅ Server registered successfully");
        logger.info("ServerManager", "📝 📊 Total servers: " + servers.size());
    }

    /**
     * Register a server with default configuration.
     */
    public void registerServer(String serverName, AsgServer server) {
        ServerConfig config = DefaultServerFactory.createServerConfig(
            server.getListeningPort(), 
            serverName, 
            context
        );
        registerServer(serverName, server, config);
    }

    /**
     * Start a specific server.
     */
    public boolean startServer(String serverName) {
        logger.info("ServerManager", "🚀 =========================================");
        logger.info("ServerManager", "🚀 STARTING SERVER");
        logger.info("ServerManager", "🚀 =========================================");
        logger.info("ServerManager", "🚀 📝 Server name: " + serverName);
        
        AsgServer server = servers.get(serverName);
        if (server == null) {
            logger.error("ServerManager", "🚀 ❌ Server not found: " + serverName);
            return false;
        }

        try {
            server.startServer();
            logger.info("ServerManager", "🚀 ✅ Server started successfully: " + serverName);
            logger.info("ServerManager", "🚀 📍 Port: " + server.getListeningPort());
            logger.info("ServerManager", "🚀 🌐 URL: " + server.getServerUrl());
            return true;
        } catch (Exception e) {
            logger.error("ServerManager", "🚀 💥 Error starting server " + serverName + ": " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * Stop a specific server.
     */
    public boolean stopServer(String serverName) {
        logger.info("ServerManager", "🛑 =========================================");
        logger.info("ServerManager", "🛑 STOPPING SERVER");
        logger.info("ServerManager", "🛑 =========================================");
        logger.info("ServerManager", "🛑 📝 Server name: " + serverName);
        
        AsgServer server = servers.get(serverName);
        if (server == null) {
            logger.error("ServerManager", "🛑 ❌ Server not found: " + serverName);
            return false;
        }

        try {
            server.stopServer();
            logger.info("ServerManager", "🛑 ✅ Server stopped successfully: " + serverName);
            return true;
        } catch (Exception e) {
            logger.error("ServerManager", "🛑 💥 Error stopping server " + serverName + ": " + e.getMessage(), e);
            return false;
        }
    }

    /**
     * Start all registered servers.
     */
    public void startAllServers() {
        logger.info("ServerManager", "🚀 =========================================");
        logger.info("ServerManager", "🚀 STARTING ALL SERVERS");
        logger.info("ServerManager", "🚀 =========================================");
        logger.info("ServerManager", "🚀 📊 Total servers to start: " + servers.size());
        
        int successCount = 0;
        int totalCount = servers.size();
        
        for (String serverName : servers.keySet()) {
            if (startServer(serverName)) {
                successCount++;
            }
        }
        
        logger.info("ServerManager", "🚀 📊 Start results: " + successCount + "/" + totalCount + " servers started");
    }

    /**
     * Stop all registered servers.
     */
    public void stopAllServers() {
        logger.info("ServerManager", "🛑 =========================================");
        logger.info("ServerManager", "🛑 STOPPING ALL SERVERS");
        logger.info("ServerManager", "🛑 =========================================");
        logger.info("ServerManager", "🛑 📊 Total servers to stop: " + servers.size());
        
        int successCount = 0;
        int totalCount = servers.size();
        
        for (String serverName : servers.keySet()) {
            if (stopServer(serverName)) {
                successCount++;
            }
        }
        
        logger.info("ServerManager", "🛑 📊 Stop results: " + successCount + "/" + totalCount + " servers stopped");
    }

    /**
     * Get a specific server instance.
     */
    public AsgServer getServer(String serverName) {
        logger.debug("ServerManager", "🔍 Getting server: " + serverName);
        AsgServer server = servers.get(serverName);
        if (server == null) {
            logger.warn("ServerManager", "🔍 ❌ Server not found: " + serverName);
        } else {
            logger.debug("ServerManager", "🔍 ✅ Server found: " + serverName);
        }
        return server;
    }

    /**
     * Get server URL by name (mediated access).
     */
    public String getServerUrl(String serverName) {
        logger.debug("ServerManager", "🌐 =========================================");
        logger.debug("ServerManager", "🌐 GETTING SERVER URL (MEDIATED ACCESS)");
        logger.debug("ServerManager", "🌐 =========================================");
        logger.debug("ServerManager", "🌐 📝 Server name: " + serverName);
        
        AsgServer server = servers.get(serverName);
        if (server == null) {
            logger.warn("ServerManager", "🌐 ❌ Server not found: " + serverName);
            return null;
        }

        try {
            String url = server.getServerUrl();
            logger.debug("ServerManager", "🌐 ✅ Server URL retrieved: " + url);
            return url;
        } catch (Exception e) {
            logger.error("ServerManager", "🌐 💥 Error getting server URL for " + serverName + ": " + e.getMessage(), e);
            return null;
        }
    }

    /**
     * Get all server URLs.
     */
    public Map<String, String> getAllServerUrls() {
        logger.debug("ServerManager", "🌐 =========================================");
        logger.debug("ServerManager", "🌐 GETTING ALL SERVER URLS (MEDIATED ACCESS)");
        logger.debug("ServerManager", "🌐 =========================================");
        logger.debug("ServerManager", "🌐 📊 Total servers: " + servers.size());
        
        Map<String, String> urls = new HashMap<>();
        int successCount = 0;
        
        for (Map.Entry<String, AsgServer> entry : servers.entrySet()) {
            String serverName = entry.getKey();
            AsgServer server = entry.getValue();
            
            try {
                String url = server.getServerUrl();
                urls.put(serverName, url);
                successCount++;
                logger.debug("ServerManager", "🌐 ✅ " + serverName + ": " + url);
            } catch (Exception e) {
                logger.error("ServerManager", "🌐 💥 Error getting URL for " + serverName + ": " + e.getMessage());
                urls.put(serverName, null);
            }
        }
        
        logger.debug("ServerManager", "🌐 📊 URLs retrieved: " + successCount + "/" + servers.size());
        return urls;
    }

    /**
     * Get primary server URL (first available running server).
     */
    public String getPrimaryServerUrl() {
        logger.debug("ServerManager", "🌐 =========================================");
        logger.debug("ServerManager", "🌐 GETTING PRIMARY SERVER URL (MEDIATED ACCESS)");
        logger.debug("ServerManager", "🌐 =========================================");
        logger.debug("ServerManager", "🌐 📊 Total servers: " + servers.size());
        
        for (Map.Entry<String, AsgServer> entry : servers.entrySet()) {
            String serverName = entry.getKey();
            AsgServer server = entry.getValue();
            
            if (server.isAlive()) {
                try {
                    String url = server.getServerUrl();
                    logger.debug("ServerManager", "🌐 ✅ Primary server found: " + serverName + " -> " + url);
                    return url;
                } catch (Exception e) {
                    logger.error("ServerManager", "🌐 💥 Error getting URL for primary server " + serverName + ": " + e.getMessage());
                }
            } else {
                logger.debug("ServerManager", "🌐 ⏸️ Server not running: " + serverName);
            }
        }
        
        logger.warn("ServerManager", "🌐 ❌ No running servers found");
        return null;
    }

    /**
     * Cleanup all resources and stop all servers.
     */
    public void cleanup() {
        logger.info("ServerManager", "🧹 =========================================");
        logger.info("ServerManager", "🧹 CLEANUP SERVER MANAGER");
        logger.info("ServerManager", "🧹 =========================================");
        logger.info("ServerManager", "🧹 📊 Total servers to cleanup: " + servers.size());
        
        stopAllServers();
        
        logger.info("ServerManager", "🧹 🧹 Clearing server collections...");
        servers.clear();
        serverConfigs.clear();
        
        logger.info("ServerManager", "🧹 ✅ Server manager cleanup completed");
    }

    // Additional getters for metrics
    public int getServerCount() { return servers.size(); }
    public String[] getServerNames() { return servers.keySet().toArray(new String[0]); }
    public boolean isServerRunning(String serverName) {
        AsgServer server = servers.get(serverName);
        return server != null && server.isAlive();
    }
} 