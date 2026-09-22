package com.mentra.asg_client.io.network.interfaces;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Semantic backend result for reliable saved-SSID enumeration. */
public final class SavedWifiNetworksResult {
    private final SavedWifiNetworksOutcome outcome;
    private final List<String> networks;
    private final String error;

    private SavedWifiNetworksResult(
            SavedWifiNetworksOutcome outcome, List<String> networks, String error) {
        this.outcome = outcome;
        this.networks = Collections.unmodifiableList(new ArrayList<>(networks));
        this.error = error;
    }

    public static SavedWifiNetworksResult confirmed(List<String> networks) {
        return new SavedWifiNetworksResult(SavedWifiNetworksOutcome.CONFIRMED, networks, null);
    }

    public static SavedWifiNetworksResult unsupported(String error) {
        return new SavedWifiNetworksResult(
                SavedWifiNetworksOutcome.UNSUPPORTED, Collections.emptyList(), error);
    }

    public static SavedWifiNetworksResult failed(String error) {
        return new SavedWifiNetworksResult(
                SavedWifiNetworksOutcome.FAILED, Collections.emptyList(), error);
    }

    public SavedWifiNetworksOutcome getOutcome() {
        return outcome;
    }

    public List<String> getNetworks() {
        return networks;
    }

    public String getError() {
        return error;
    }
}
