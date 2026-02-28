package com.mentra.asg_client.camera;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.Assert;

import java.io.File;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

@RunWith(org.junit.runners.JUnit4.class)
public class MediaUploadTest {
    private static final String TAG = "MediaUploadTest";
    private static final String UPLOAD_URL = "https://dev.augmentos.org/api/photos/upload";
    private static final String AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkOWM2NTNkYi1iOTI3LTQyNjItOGNkNC1jNTYxN2M2ZGVkNDciLCJlbWFpbCI6ImxvcmlhbWlzdGFkaTc1QGdtYWlsLmNvbSIsIm9yZ2FuaXphdGlvbnMiOlsiNjgzNGMzNDM4MDIxZWU2OGJkZTdhYmM3Il0sImRlZmF1bHRPcmciOiI2ODM0YzM0MzgwMjFlZTY4YmRlN2FiYzciLCJpYXQiOjE3NDkzMzYwMTF9.oErxaAiRMV3A7c4cIwual9qGrTHTGfIAzc_OVMUE52o";
    
    private OkHttpClient client;

    @Before
    public void setup() {
        client = new OkHttpClient.Builder()
                .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .writeTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(60, java.util.concurrent.TimeUnit.SECONDS)
                .build();
    }

    @Test
    public void testPhotoUpload() throws Exception {
        // Use the provided image file
        String projectDir = System.getProperty("user.dir");
        System.out.println("Project directory: " + projectDir);
        File imageFile = new File("/Users/nicolomicheletti/StudioProjects/AugmentOS/asg_client/app/src/test/java/com/augmentos/asg_client/camera/test_image.png");
        System.out.println("Looking for image at: " + imageFile.getAbsolutePath());
        System.out.println("Current directory contents:");
        File currentDir = new File(projectDir);
        for (File file : currentDir.listFiles()) {
            System.out.println("- " + file.getName());
        }

        Assert.assertNotNull("Image file should not be null", imageFile);
        Assert.assertTrue("Image file should exist", imageFile.exists());
        Assert.assertTrue("Image file should not be empty", imageFile.length() > 0);

        System.out.println("Image file size: " + imageFile.length() + " bytes");
        System.out.println("Image file path: " + imageFile.getAbsolutePath());

        // Create metadata
        JSONObject metadata = new JSONObject();
        String requestId = "test_" + System.currentTimeMillis();
        metadata.put("requestId", requestId);
        metadata.put("deviceId", "K900_unknown");
        metadata.put("timestamp", System.currentTimeMillis());
        metadata.put("mediaType", "photo");
        metadata.put("appId", "asg_client");

        System.out.println("Metadata: " + metadata.toString());

        // Create multipart request
        RequestBody requestBody = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", imageFile.getName(),
                        RequestBody.create(MediaType.parse("image/jpeg"), imageFile))
                .addFormDataPart("metadata", metadata.toString())
                .build();

        // Build request
        Request request = new Request.Builder()
                .url(UPLOAD_URL)
                .header("Authorization", "Bearer " + AUTH_TOKEN)
                .post(requestBody)
                .build();

        System.out.println("Request URL: " + request.url());
        System.out.println("Request headers: " + request.headers());

        // Execute request
        try (Response response = client.newCall(request).execute()) {
            String responseBody = response.body() != null ? response.body().string() : "<no body>";
            if (!response.isSuccessful()) {
                System.out.println("Upload failed. Response code: " + response.code());
                System.out.println("Response body: " + responseBody);
            }
            Assert.assertTrue("Response should be successful", response.isSuccessful());
            Assert.assertEquals("Response code should be 200", 200, response.code());
            
            Assert.assertNotNull("Response body should not be null", responseBody);
            Assert.assertFalse("Response body should not be empty", responseBody.isEmpty());
        }  // Remove file deletion block to preserve the test image
    }
}
