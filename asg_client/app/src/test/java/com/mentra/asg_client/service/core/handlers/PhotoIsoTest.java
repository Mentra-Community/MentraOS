package com.mentra.asg_client.service.core.handlers;

import org.json.JSONObject;
import org.junit.Assert;
import org.junit.Test;

public class PhotoIsoTest {

    @Test
    public void parse_positiveNumber_returnsInt() throws Exception {
        JSONObject o = new JSONObject();
        o.put("iso", 800);

        Assert.assertEquals(Integer.valueOf(800), PhotoIso.parse(o));
    }

    @Test
    public void parse_floatNumber_truncatesToInt() throws Exception {
        JSONObject o = new JSONObject();
        o.put("iso", 800.9);

        Assert.assertEquals(Integer.valueOf(800), PhotoIso.parse(o));
    }

    @Test
    public void parse_invalidValues_returnNull() throws Exception {
        Assert.assertNull(PhotoIso.parse(new JSONObject()));
        Assert.assertNull(PhotoIso.parse(new JSONObject().put("iso", 0)));
        Assert.assertNull(PhotoIso.parse(new JSONObject().put("iso", -100)));
        Assert.assertNull(PhotoIso.parse(new JSONObject().put("iso", "fast")));
        Assert.assertNull(PhotoIso.parse(new JSONObject().put("iso", JSONObject.NULL)));
    }
}
