package com.mentra.asg_client.io.network.utils;

import android.content.Context;

import org.webrtc.NetworkChangeDetector;
import org.webrtc.NetworkMonitorAutoDetect;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Supplier;

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

    private final NetworkChangeDetector mDelegate;
    private final Observer mObserver;
    private final Supplier<HotspotNetworkUtils.HotspotInterface> mHotspotSupplier;
    private final HotspotNetworkUtils.HotspotStateListener mHotspotStateListener;
    private final Object mHotspotLock = new Object();
    private NetworkInformation mPublishedHotspot;
    private volatile boolean mHotspotEnabled;

    public HotspotAwareNetworkChangeDetector(Observer observer, Context context) {
        this(
                observer,
                new NetworkMonitorAutoDetect(observer, context),
                HotspotNetworkUtils::getActiveHotspotInterface);
    }

    HotspotAwareNetworkChangeDetector(
            Observer observer,
            NetworkChangeDetector delegate,
            Supplier<HotspotNetworkUtils.HotspotInterface> hotspotSupplier) {
        mObserver = observer;
        mDelegate = delegate;
        mHotspotSupplier = hotspotSupplier;
        mHotspotEnabled = hotspotSupplier.get() != null;
        mHotspotStateListener = this::onHotspotStateChanged;
        HotspotNetworkUtils.addHotspotStateListener(mHotspotStateListener);
    }

    @Override
    public ConnectionType getCurrentConnectionType() {
        ConnectionType delegateType = mDelegate.getCurrentConnectionType();
        if (delegateType == ConnectionType.CONNECTION_NONE && mHotspotEnabled) {
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
        HotspotNetworkUtils.HotspotInterface hotspot;
        synchronized (mHotspotLock) {
            hotspot = mHotspotEnabled ? mHotspotSupplier.get() : null;
            NetworkInformation currentHotspot =
                    hotspot != null && !containsInterface(detectedNetworks, hotspot.getName())
                            ? createNetworkInformation(hotspot)
                            : null;
            if (currentHotspot != null) {
                mPublishedHotspot = currentHotspot;
            }
        }
        return mergeNetworks(detectedNetworks, hotspot);
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
        HotspotNetworkUtils.removeHotspotStateListener(mHotspotStateListener);
        mDelegate.destroy();
    }

    void onHotspotStateChanged(boolean enabled) {
        NetworkInformation connectedNetwork = null;
        boolean disconnected = false;
        synchronized (mHotspotLock) {
            if (enabled) {
                mHotspotEnabled = true;
                if (mPublishedHotspot != null) {
                    return;
                }
                HotspotNetworkUtils.HotspotInterface hotspot = mHotspotSupplier.get();
                if (hotspot != null
                        && containsInterface(mDelegate.getActiveNetworkList(), hotspot.getName())) {
                    return;
                }
                connectedNetwork = createNetworkInformation(hotspot);
                if (connectedNetwork == null) {
                    return;
                }
                mPublishedHotspot = connectedNetwork;
            } else if (mPublishedHotspot != null) {
                mHotspotEnabled = false;
                mPublishedHotspot = null;
                disconnected = true;
            } else {
                mHotspotEnabled = false;
            }
        }

        if (connectedNetwork != null) {
            mObserver.onNetworkConnect(connectedNetwork);
            if (mDelegate.getCurrentConnectionType() == ConnectionType.CONNECTION_NONE) {
                mObserver.onConnectionTypeChanged(ConnectionType.CONNECTION_WIFI);
            }
        } else if (disconnected) {
            mObserver.onNetworkDisconnect(LOCAL_ONLY_NETWORK_HANDLE);
            if (mDelegate.getCurrentConnectionType() == ConnectionType.CONNECTION_NONE) {
                mObserver.onConnectionTypeChanged(ConnectionType.CONNECTION_NONE);
            }
        }
    }

    static NetworkInformation createNetworkInformation(
            HotspotNetworkUtils.HotspotInterface hotspot) {
        if (hotspot == null) {
            return null;
        }
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
        if (networks == null) {
            return false;
        }
        for (NetworkInformation network : networks) {
            if (name.equals(network.name)) {
                return true;
            }
        }
        return false;
    }
}
