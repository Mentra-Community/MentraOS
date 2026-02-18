package com.mentra.asg_client.io.bes.protocol;

/**
 * Select A/B partition for firmware update
 * BES uses dual partition scheme for safe updates
 */
public class BesCmd_SelectSide extends BesBaseCommand {
    public BesCmd_SelectSide() {
        super(BesProtocolConstants.SCMD_SELECT_SIDE);
    }
}

