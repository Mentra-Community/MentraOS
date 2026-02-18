package com.mentra.asg_client.io.bes.protocol;

/**
 * Signal firmware transfer completion
 * Sent after all data packets have been transmitted
 */
public class BesCmd_FinishSend extends BesBaseCommand {
    public BesCmd_FinishSend() {
        super(BesProtocolConstants.SCMD_SEND_FINISH);
    }
}

