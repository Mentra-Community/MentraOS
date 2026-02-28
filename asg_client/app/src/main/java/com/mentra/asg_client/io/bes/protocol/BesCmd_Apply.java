package com.mentra.asg_client.io.bes.protocol;

/**
 * Apply firmware and reboot BES
 * Final command - BES will reboot with new firmware
 */
public class BesCmd_Apply extends BesBaseCommand {
    public BesCmd_Apply() {
        super(BesProtocolConstants.SCMD_APPLY);
    }
}

