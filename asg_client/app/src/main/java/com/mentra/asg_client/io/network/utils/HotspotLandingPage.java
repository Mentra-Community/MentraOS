package com.mentra.asg_client.io.network.utils;

import android.content.Context;
import androidx.annotation.NonNull;
import com.mentra.asg_client.R;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Shared WiFi hotspot captive-portal HTML loaded from {@code res/raw/hotspot_landing_page.html}.
 */
public final class HotspotLandingPage {

    private HotspotLandingPage() {}

    @NonNull
    public static String load(@NonNull Context context) throws IOException {
        try (InputStream in = context.getResources().openRawResource(R.raw.hotspot_landing_page);
                BufferedReader reader =
                        new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            StringBuilder html = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                html.append(line);
            }
            return html.toString();
        }
    }
}
