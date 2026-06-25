package com.mentra.asg_client.service.core.handlers;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.lang.reflect.Method;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaCommandHandlerTest {

    @Test
    public void getValidatedOtaVersionUrl_missingField_returnsNull() throws Exception {
        assertNull(validate(new JSONObject()));
    }

    @Test
    public void getValidatedOtaVersionUrl_validHttps_returnsTrimmedUrl() throws Exception {
        assertEquals(
                "https://ota.mentraglass.com/sdk_live_version.json",
                validate(
                        new JSONObject()
                                .put(
                                        "ota_version_url",
                                        " https://ota.mentraglass.com/sdk_live_version.json ")));
    }

    @Test
    public void getValidatedOtaVersionUrl_validHttp_returnsUrl() throws Exception {
        assertEquals(
                "http://192.168.1.2/version.json",
                validate(
                        new JSONObject()
                                .put("ota_version_url", "http://192.168.1.2/version.json")));
    }

    @Test
    public void getValidatedOtaVersionUrl_rejectsEmptyUrl() throws Exception {
        assertEquals(
                "invalid_ota_version_url", validate(new JSONObject().put("ota_version_url", " ")));
    }

    @Test
    public void getValidatedOtaVersionUrl_rejectsNonHttpUrl() throws Exception {
        assertEquals(
                "invalid_ota_version_url",
                validate(new JSONObject().put("ota_version_url", "file:///tmp/version.json")));
    }

    private String validate(JSONObject data) throws Exception {
        Method method =
                OtaCommandHandler.class.getDeclaredMethod("getValidatedOtaVersionUrl", JSONObject.class);
        method.setAccessible(true);
        return (String) method.invoke(new OtaCommandHandler(), data);
    }
}
