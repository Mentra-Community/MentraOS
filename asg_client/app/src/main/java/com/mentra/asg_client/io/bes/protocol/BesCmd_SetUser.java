package com.mentra.asg_client.io.bes.protocol;

/**
 * Set user type for OTA update
 * Indicates what type of update is being performed
 */
public class BesCmd_SetUser extends BesBaseCommand {
    public BesCmd_SetUser() {
        super(BesProtocolConstants.SCMD_SET_USER);
    }
}

