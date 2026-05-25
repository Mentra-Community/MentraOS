package com.mentra.asg_client.service.core.handlers;

import org.json.JSONObject;
import org.junit.Assert;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(org.junit.runners.JUnit4.class)
public class PhotoExposureTimeNsTest {

    @Test
    public void parse_missing_returnsNull() throws Exception {
        Assert.assertNull(PhotoExposureTimeNs.parse(new JSONObject("{}")));
    }

    @Test
    public void parse_positive_returnsLong() throws Exception {
        JSONObject o = new JSONObject();
        o.put("exposureTimeNs", 33_333_333L);
        Assert.assertEquals(Long.valueOf(33_333_333L), PhotoExposureTimeNs.parse(o));
    }

    @Test
    public void parse_zero_returnsNull() throws Exception {
        JSONObject o = new JSONObject();
        o.put("exposureTimeNs", 0);
        Assert.assertNull(PhotoExposureTimeNs.parse(o));
    }

    @Test
    public void parse_negative_returnsNull() throws Exception {
        JSONObject o = new JSONObject();
        o.put("exposureTimeNs", -100);
        Assert.assertNull(PhotoExposureTimeNs.parse(o));
    }

    @Test
    public void parse_nonNumeric_returnsNull() throws Exception {
        JSONObject o = new JSONObject();
        o.put("exposureTimeNs", "fast");
        Assert.assertNull(PhotoExposureTimeNs.parse(o));
    }

    @Test
    public void parse_nullField_returnsNull() throws Exception {
        JSONObject o = new JSONObject();
        o.put("exposureTimeNs", JSONObject.NULL);
        Assert.assertNull(PhotoExposureTimeNs.parse(o));
    }
}
