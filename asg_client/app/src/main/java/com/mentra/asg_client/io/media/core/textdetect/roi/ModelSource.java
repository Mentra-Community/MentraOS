package com.mentra.asg_client.io.media.core.textdetect.roi;

import java.io.IOException;

/** Source of serialized neural-network model assets. */
@FunctionalInterface
public interface ModelSource {
    /**
     * Loads an entire model asset.
     *
     * @param assetName model filename
     * @return serialized model bytes
     * @throws IOException when the asset cannot be read
     */
    byte[] load(String assetName) throws IOException;
}
