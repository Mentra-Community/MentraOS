package com.mentra.asg_client.io.bes.protocol;

import com.mentra.asg_client.io.bes.util.BesOtaUtil;

/**
 * Read current firmware version from BES
 * Returns version info including magic code and version bytes
 */
public class BesCmd_GetFirmwareVersion extends BesBaseCommand {
    public BesCmd_GetFirmwareVersion() {
        super(BesProtocolConstants.SCMD_GET_FIRMWARE_VERSION);
        setMagicCode();
    }

    public void setMagicCode() {
        setPlayload(BesOtaUtil.MAGIC_CODE);
    }
}

