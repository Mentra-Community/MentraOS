package com.mentra.asg_client.io.network.utils;

import android.text.TextUtils;
import androidx.annotation.Nullable;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

/** Parses WiFi credentials from hotspot captive-portal HTTP requests. */
public final class HotspotSetupRequestParser {

    /** Max POST body size for captive-portal form data (ssid, pass, token). */
    public static final int MAX_HTTP_BODY_BYTES = 8192;

    private HotspotSetupRequestParser() {}

    public static final class Credentials {
        @Nullable public final String ssid;
        @Nullable public final String password;
        @Nullable public final String token;

        public Credentials(
                @Nullable String ssid, @Nullable String password, @Nullable String token) {
            this.ssid = ssid;
            this.password = password;
            this.token = token;
        }

        public boolean hasWifiCredentials() {
            return ssid != null && !ssid.isEmpty() && password != null && !password.isEmpty();
        }
    }

    @Nullable
    public static Credentials parseFormUrlEncoded(@Nullable String encoded) {
        if (encoded == null || encoded.isEmpty()) {
            return null;
        }
        String ssid = null;
        String password = null;
        String token = null;
        for (String pair : encoded.split("&")) {
            String[] kv = pair.split("=", 2);
            if (kv.length != 2) {
                continue;
            }
            String key = urlDecode(kv[0].trim());
            String value = urlDecode(kv[1].trim());
            if ("ssid".equalsIgnoreCase(key)) {
                ssid = value;
            } else if ("pass".equalsIgnoreCase(key)) {
                password = value;
            } else if ("token".equalsIgnoreCase(key)) {
                token = value;
            }
        }
        if (ssid == null && password == null && token == null) {
            return null;
        }
        return new Credentials(ssid, password, token);
    }

    @Nullable
    public static Credentials parseGetRequestLine(@Nullable String requestLine) {
        if (requestLine == null || !requestLine.startsWith("GET")) {
            return null;
        }
        int queryStart = requestLine.indexOf('?');
        if (queryStart == -1) {
            return null;
        }
        String query = requestLine.substring(queryStart + 1);
        int endIndex = query.indexOf(" HTTP/");
        if (endIndex != -1) {
            query = query.substring(0, endIndex);
        }
        return parseFormUrlEncoded(query);
    }

    public static int parseContentLengthHeader(@Nullable String headerLine) {
        if (headerLine == null) {
            return 0;
        }
        String lower = headerLine.toLowerCase();
        if (!lower.startsWith("content-length:")) {
            return 0;
        }
        try {
            return Integer.parseInt(headerLine.substring(15).trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    public static String escapeHtml(@Nullable String text) {
        return text == null ? "" : TextUtils.htmlEncode(text);
    }

    /** Writes a minimal HTTP/1.1 HTML response using UTF-8 for headers and body. */
    public static void writeHtmlResponse(OutputStream output, String htmlBody) throws IOException {
        byte[] bodyBytes = htmlBody.getBytes(StandardCharsets.UTF_8);
        String headers =
                "HTTP/1.1 200 OK\r\n"
                        + "Content-Type: text/html; charset=UTF-8\r\n"
                        + "Content-Length: "
                        + bodyBytes.length
                        + "\r\n"
                        + "Connection: close\r\n"
                        + "\r\n";
        output.write(headers.getBytes(StandardCharsets.UTF_8));
        output.write(bodyBytes);
    }

    @Nullable
    public static String readHttpBody(BufferedReader reader, int contentLength) throws IOException {
        if (contentLength <= 0) {
            return "";
        }
        if (contentLength > MAX_HTTP_BODY_BYTES) {
            throw new IOException("Request body too large: " + contentLength);
        }
        char[] buf = new char[contentLength];
        int read = 0;
        while (read < contentLength) {
            int n = reader.read(buf, read, contentLength - read);
            if (n < 0) {
                break;
            }
            read += n;
        }
        return new String(buf, 0, read);
    }

    private static String urlDecode(String value) {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (IllegalArgumentException | UnsupportedEncodingException e) {
            return value;
        }
    }
}
