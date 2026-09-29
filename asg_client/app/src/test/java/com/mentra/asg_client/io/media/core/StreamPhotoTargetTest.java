package com.mentra.asg_client.io.media.core;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Only the phone's local still endpoint on the hotspot may turn a take_photo into a stream photo. */
public class StreamPhotoTargetTest {

    @Test
    public void acceptsThePhonesHotspotStillEndpoint() {
        assertTrue(StreamPhotoTarget.isLocalStillUpload("http://192.168.43.117:40203/photo/abc123"));
        assertTrue(StreamPhotoTarget.isLocalStillUpload("http://10.0.0.2/photo/req-1"));
        assertTrue(StreamPhotoTarget.isLocalStillUpload("http://172.20.1.5:8080/photo/x?attempt=1"));
    }

    @Test
    public void rejectsCloudAndNonHttpTargets() {
        assertFalse(StreamPhotoTarget.isLocalStillUpload("https://192.168.43.117:40203/photo/abc"));
        assertFalse(StreamPhotoTarget.isLocalStillUpload("https://api.mentra.glass/photo/abc"));
        assertFalse(StreamPhotoTarget.isLocalStillUpload("http://api.mentra.glass/photo/abc"));
        assertFalse(StreamPhotoTarget.isLocalStillUpload("http://8.8.8.8/photo/abc"));
        assertFalse(StreamPhotoTarget.isLocalStillUpload("http://172.32.0.1/photo/abc"));
        assertFalse(StreamPhotoTarget.isLocalStillUpload(""));
        assertFalse(StreamPhotoTarget.isLocalStillUpload(null));
        assertFalse(StreamPhotoTarget.isLocalStillUpload("not a url"));
    }

    @Test
    public void rejectsOtherPathsOnTheHotspot() {
        assertFalse(StreamPhotoTarget.isLocalStillUpload("http://192.168.43.117:40203/whip"));
        assertFalse(StreamPhotoTarget.isLocalStillUpload("http://192.168.43.117:40203/photo/"));
        assertFalse(StreamPhotoTarget.isLocalStillUpload("http://192.168.43.117:40203/photo/a/b"));
        assertFalse(StreamPhotoTarget.isLocalStillUpload("http://192.168.43.117:40203/photos/a"));
    }

    @Test
    public void rejectsMalformedAddresses() {
        assertFalse(StreamPhotoTarget.isPrivateIpv4("192.168.43"));
        assertFalse(StreamPhotoTarget.isPrivateIpv4("192.168.43.256"));
        assertFalse(StreamPhotoTarget.isPrivateIpv4("192.168.-1.1"));
        assertFalse(StreamPhotoTarget.isPrivateIpv4("192.168.1.1.1"));
    }
}
