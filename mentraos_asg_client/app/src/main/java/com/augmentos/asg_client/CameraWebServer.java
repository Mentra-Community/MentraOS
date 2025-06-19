package com.augmentos.asg_client;

import android.content.Context;
import android.util.Log;

import com.augmentos.asg_client.camera.CameraNeo;

import fi.iki.elonen.NanoHTTPD;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public class CameraWebServer extends NanoHTTPD {

    private static final String TAG = "CameraWebServer";
    private Context context;


    /** Callback interface for handling "take-picture" requests. */
    public interface OnPictureRequestListener {
        void onPictureRequest();
    }

    private OnPictureRequestListener pictureRequestListener;

    /**
     * Creates a web server on the specified port (e.g., 8089).
     */
    public CameraWebServer(Context context, int port) {
        super(port);
        this.context = context;
    }

    /**
     * Set the listener that will be notified when someone clicks "take picture."
     */
    public void setOnPictureRequestListener(OnPictureRequestListener listener) {
        this.pictureRequestListener = listener;
    }

    /**
     * Start the server.
     */
    public void startServer() {
        try {
            this.start(SOCKET_READ_TIMEOUT, false);
            Log.d(TAG, "Server started on port " + getListeningPort());
        } catch (IOException e) {
            Log.e(TAG, "Failed to start server: " + e.getMessage());
        }
    }

    /**
     * Stop the server.
     */
    public void stopServer() {
        this.stop();
        Log.d(TAG, "Server stopped.");
    }

    /**
     * Handle incoming requests.
     */
    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        Method method = session.getMethod();
        Log.d(TAG, "Request received: " + method + " " + uri);

        // Route: GET /
        switch (uri) {
            case "/":
                return serveIndexPage();
            case "/take-picture":
                if (pictureRequestListener != null) {
                    pictureRequestListener.onPictureRequest();
                }
                return newFixedLengthResponse(Response.Status.OK, "text/plain",
                        "Picture request received.");
            case "/latest-photo":
                return serveLatestPhoto();
            default:
                return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not Found");
        }
    }

    private Response serveLatestPhoto() {
        // Here is where we retrieve the last photo path from the service (or static storage)
        String path = CameraNeo.getLastPhotoPath();
        if (path == null) {
            return newFixedLengthResponse(Response.Status.OK,
                    "text/plain", "No photo taken yet.");
        }

        File photoFile = new File(path);
        if (!photoFile.exists()) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND,
                    "text/plain", "Photo file not found.");
        }

        try {
            // Return a chunked response so we can stream the file
            return newChunkedResponse(Response.Status.OK, "image/jpeg",
                    new FileInputStream(photoFile));
        } catch (IOException e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR,
                    "text/plain", "Error reading file: " + e.getMessage());
        }
    }


    /**
     * Serve the main index page with a "Take Picture" button.
     */

    private Response serveIndexPage() {
        try {
            // Open the index.html file from assets
            InputStream is = context.getAssets().open("index.html");

            // Read it into a String
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            int nRead;
            byte[] data = new byte[1024];
            while ((nRead = is.read(data, 0, data.length)) != -1) {
                buffer.write(data, 0, nRead);
            }
            buffer.flush();

            String html = new String(buffer.toByteArray(), StandardCharsets.UTF_8);

            return newFixedLengthResponse(Response.Status.OK, "text/html", html);
        } catch (IOException e) {
            Log.e(TAG, "Error reading index.html from assets", e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR,
                    "text/plain",
                    "Failed to load index.html");
        }
    }

//    private Response serveIndexPage() {
//        String html = "<!DOCTYPE html>\n"
//                + "<html>\n"
//                + "  <head>\n"
//                + "    <meta charset='UTF-8' />\n"
//                + "    <title>Camera Server</title>\n"
//                + "  </head>\n"
//                + "  <body>\n"
//                + "    <h1>Hello from the Camera Web Server!</h1>\n"
//                + "    <button onclick=\"takePicture()\">Take a Picture</button>\n"
//                + "    <img id=\"latestPhoto\" src=\"/latest-photo\" "
//                + "         style=\"display:block; margin-top:20px; max-width:300px;\"/>\n"
//                + "    <script>\n"
//                + "      function takePicture() {\n"
//                + "        fetch('/take-picture')\n"
//                + "          .then(response => response.text())\n"
//                + "          .then(text => {\n"
//                + "            // Force the image to reload after taking a new picture\n"
//                + "            document.getElementById('latestPhoto').src = '/latest-photo?cachebust=' + Date.now();\n"
//                + "          })\n"
//                + "          .catch(err => {\n"
//                + "            alert('Error: ' + err);\n"
//                + "          });\n"
//                + "      }\n"
//                + "    </script>\n"
//                + "  </body>\n"
//                + "</html>\n";
//
//        return newFixedLengthResponse(Response.Status.OK, "text/html", html);
//    }

}
