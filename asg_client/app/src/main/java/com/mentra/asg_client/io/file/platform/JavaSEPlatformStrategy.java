package com.mentra.asg_client.io.file.platform;

import com.mentra.asg_client.logging.Logger;
import java.io.File;

/**
 * Java SE platform strategy implementation.
 * Follows Open/Closed Principle by extending PlatformStrategy.
 */
public class JavaSEPlatformStrategy implements PlatformStrategy {
    
    @Override
    public File getBaseDirectory() {
        return new File(System.getProperty("user.home"), "asg_files");
    }
    
    @Override
    public Logger createLogger() {
        return new com.mentra.asg_client.logging.ConsoleLogger();
    }
    
    @Override
    public String getPlatformName() {
        return "Java SE";
    }
    
    @Override
    public boolean isSupported() {
        // Java SE is always supported
        return true;
    }
    

} 