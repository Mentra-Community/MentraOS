package com.mentra.asg_client.io.bes.protocol;

/**
 * Query BES protocol version
 * First command in OTA sequence
 */
public class BesCmd_GetProtocolVersion extends BesBaseCommand {
    public BesCmd_GetProtocolVersion() {
        super(BesProtocolConstants.SCMD_GET_PROTOCOL_VERSION);
    }
}
