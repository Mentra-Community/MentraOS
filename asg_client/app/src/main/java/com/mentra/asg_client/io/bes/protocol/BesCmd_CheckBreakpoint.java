package com.mentra.asg_client.io.bes.protocol;

/**
 * Check for breakpoint to resume interrupted update
 * Allows continuing from where update was interrupted
 */
public class BesCmd_CheckBreakpoint extends BesBaseCommand {
    public BesCmd_CheckBreakpoint() {
        super(BesProtocolConstants.SCMD_GET_BREAKPOINT);
    }
}

