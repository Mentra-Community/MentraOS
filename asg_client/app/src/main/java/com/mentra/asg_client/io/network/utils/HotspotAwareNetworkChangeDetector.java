package com.mentra.asg_client.io.network.utils;

import android.content.Context;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import org.webrtc.NetworkChangeDetector;
import org.webrtc.NetworkMonitorAutoDetect;

/**
 * Adds the local-only Mentra Live hotspot to WebRTC's Android network inventory.
 *
 * <p>Android's {@link android.net.ConnectivityManager} does not expose the tethering-side {@code
 * ap0} interface as an Internet-capable {@link android.net.Network}, so the stock WebRTC detector
 * omits it. Handle {@code 0} matches WebRTC's WiFi Direct behavior: ICE binds to the interface
 * address without trying to bind the socket through a ConnectivityManager network handle.
 */
public final class HotspotAwareNetworkChangeDetector implements NetworkChangeDetector {
    private static final long LOCAL_ONLY_NETWORK_HANDLE = 0L;

    private final NetworkMonitorAutoDetect mDelegate;

    public HotspotAwareNetworkChangeDetector(Observer observer, Context context) {
        mDelegate = new NetworkMonitorAutoDetect(observer, context);
    }

    @Override
    public ConnectionType getCurrentConnectionType() {
        ConnectionType delegateType = mDelegate.getCurrentConnectionType();
        if (delegateType == ConnectionType.CONNECTION_NONE
                && HotspotNetworkUtils.getActiveHotspotInterface() != null) {
            return ConnectionType.CONNECTION_WIFI;
        }
        return delegateType;
    }

    @Override
    public boolean supportNetworkCallback() {
        return mDelegate.supportNetworkCallback();
    }

    @Override
    public List<NetworkInformation> getActiveNetworkList() {
        List<NetworkInformation> detectedNetworks = mDelegate.getActiveNetworkList();
        return mergeNetworks(detectedNetworks, HotspotNetworkUtils.getActiveHotspotInterface());
    }

    static List<NetworkInformation> mergeNetworks(
            List<NetworkInformation> detectedNetworks,
            HotspotNetworkUtils.HotspotInterface hotspot) {
        List<NetworkInformation> result =
                detectedNetworks == null ? new ArrayList<>() : new ArrayList<>(detectedNetworks);

        if (hotspot == null || containsInterface(result, hotspot.getName())) {
            return result;
        }

        NetworkInformation hotspotNetwork = createNetworkInformation(hotspot);
        if (hotspotNetwork != null) {
            result.add(hotspotNetwork);
        }
        return result;
    }

    @Override
    public void destroy() {
        mDelegate.destroy();
    }

    static NetworkInformation createNetworkInformation(
            HotspotNetworkUtils.HotspotInterface hotspot) {
        List<InetAddress> addresses = hotspot.getAddresses();
        if (addresses.isEmpty()) {
            return null;
        }
        IPAddress[] webRtcAddresses = new IPAddress[addresses.size()];
        for (int i = 0; i < addresses.size(); i++) {
            webRtcAddresses[i] = new IPAddress(addresses.get(i).getAddress());
        }
        return new NetworkInformation(
                hotspot.getName(),
                ConnectionType.CONNECTION_WIFI,
                ConnectionType.CONNECTION_NONE,
                LOCAL_ONLY_NETWORK_HANDLE,
                webRtcAddresses);
    }

    private static boolean containsInterface(List<NetworkInformation> networks, String name) {
        for (NetworkInformation network : networks) {
            if (name.equals(network.name)) {
                return true;
            }
        }
        return false;
    }
}
