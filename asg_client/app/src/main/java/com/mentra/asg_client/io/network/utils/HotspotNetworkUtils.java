package com.mentra.asg_client.io.network.utils;

import android.util.Log;

import com.mentra.asg_client.AsgConstants;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.URI;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Utilities for discovering and addressing the active Mentra Live hotspot interface. */
public final class HotspotNetworkUtils {
    private static final String TAG = "HotspotNetworkUtils";
    private static final Object HOTSPOT_STATE_LOCK = new Object();
    private static final Map<HotspotStateListener, HotspotStateRegistration>
            HOTSPOT_STATE_LISTENERS = new HashMap<>();
    private static Boolean sLastHotspotState;
    private static long sHotspotStateVersion;

    private HotspotNetworkUtils() {}

    /** Receives in-process hotspot lifecycle changes after the AP becomes ready or stops. */
    public interface HotspotStateListener {
        void onHotspotStateChanged(boolean enabled);
    }

    /** Registers a listener and replays the latest hotspot lifecycle state, when known. */
    public static void addHotspotStateListener(HotspotStateListener listener) {
        HotspotStateRegistration registration;
        Boolean replayState;
        long replayVersion;
        synchronized (HOTSPOT_STATE_LOCK) {
            if (listener == null) {
                return;
            }
            registration =
                    HOTSPOT_STATE_LISTENERS.computeIfAbsent(
                            listener, HotspotStateRegistration::new);
            replayState = sLastHotspotState;
            replayVersion = sHotspotStateVersion;
        }
        if (replayState != null) {
            enqueueHotspotState(registration, replayState, replayVersion);
        }
    }

    /** Removes a previously registered hotspot lifecycle listener. */
    public static void removeHotspotStateListener(HotspotStateListener listener) {
        HotspotStateRegistration registration;
        synchronized (HOTSPOT_STATE_LOCK) {
            registration =
                    listener == null ? null : HOTSPOT_STATE_LISTENERS.remove(listener);
        }
        if (registration != null) {
            registration.deactivate();
        }
    }

    /** Publishes a hotspot lifecycle change to in-process network consumers such as WebRTC. */
    public static void notifyHotspotStateChanged(boolean enabled) {
        List<HotspotStateRegistration> registrations;
        long version;
        synchronized (HOTSPOT_STATE_LOCK) {
            sLastHotspotState = enabled;
            version = ++sHotspotStateVersion;
            registrations = new ArrayList<>(HOTSPOT_STATE_LISTENERS.values());
        }
        for (HotspotStateRegistration registration : registrations) {
            enqueueHotspotState(registration, enabled, version);
        }
    }

    static void resetHotspotStateForTests() {
        List<HotspotStateRegistration> registrations;
        synchronized (HOTSPOT_STATE_LOCK) {
            sLastHotspotState = null;
            sHotspotStateVersion = 0;
            registrations = new ArrayList<>(HOTSPOT_STATE_LISTENERS.values());
            HOTSPOT_STATE_LISTENERS.clear();
        }
        for (HotspotStateRegistration registration : registrations) {
            registration.deactivate();
        }
    }

    private static void enqueueHotspotState(
            HotspotStateRegistration registration, boolean enabled, long version) {
        if (!registration.enqueue(enabled, version)) {
            return;
        }

        HotspotStateEvent event;
        while ((event = registration.next()) != null) {
            try {
                registration.listener.onHotspotStateChanged(event.enabled);
            } catch (RuntimeException e) {
                Log.w(TAG, "Hotspot state listener failed", e);
            }
        }
    }

    private static final class HotspotStateEvent {
        final boolean enabled;

        HotspotStateEvent(boolean enabled) {
            this.enabled = enabled;
        }
    }

    private static final class HotspotStateRegistration {
        final HotspotStateListener listener;
        final ArrayDeque<HotspotStateEvent> pendingEvents = new ArrayDeque<>();
        boolean active = true;
        boolean delivering;
        long lastEnqueuedVersion = -1;

        HotspotStateRegistration(HotspotStateListener listener) {
            this.listener = listener;
        }

        synchronized boolean enqueue(boolean enabled, long version) {
            if (!active || version <= lastEnqueuedVersion) {
                return false;
            }
            lastEnqueuedVersion = version;
            pendingEvents.add(new HotspotStateEvent(enabled));
            if (delivering) {
                return false;
            }
            delivering = true;
            return true;
        }

        synchronized HotspotStateEvent next() {
            if (!active) {
                pendingEvents.clear();
                delivering = false;
                return null;
            }
            HotspotStateEvent event = pendingEvents.poll();
            if (event == null) {
                delivering = false;
            }
            return event;
        }

        synchronized void deactivate() {
            active = false;
            pendingEvents.clear();
        }
    }

    /** Snapshot of an active hotspot interface and the addresses WebRTC should expose for it. */
    public static final class HotspotInterface {
        private final String mName;
        private final List<InetAddress> mAddresses;

        HotspotInterface(String name, List<InetAddress> addresses) {
            mName = name;
            mAddresses = Collections.unmodifiableList(new ArrayList<>(addresses));
        }

        public String getName() {
            return mName;
        }

        public List<InetAddress> getAddresses() {
            return mAddresses;
        }
    }

    /**
     * Returns whether a stream endpoint is directly reachable through the active hotspot subnet.
     *
     * <p>The subnet is derived from the live {@code ap0} address and prefix instead of assuming
     * that the platform will always assign {@code 192.168.43.0/24}.
     */
    public static boolean isEndpointOnActiveHotspot(String endpointUrl) {
        Inet4Address endpointAddress = parseIpv4Endpoint(endpointUrl);
        if (endpointAddress == null) {
            return false;
        }

        try {
            NetworkInterface hotspotInterface = findActiveHotspotNetworkInterface();
            if (hotspotInterface == null) {
                return false;
            }
            for (InterfaceAddress interfaceAddress : hotspotInterface.getInterfaceAddresses()) {
                InetAddress localAddress = interfaceAddress.getAddress();
                if (localAddress instanceof Inet4Address
                        && isAddressInSubnet(
                                endpointAddress,
                                (Inet4Address) localAddress,
                                interfaceAddress.getNetworkPrefixLength())) {
                    Log.i(
                            TAG,
                            "Stream endpoint "
                                    + endpointAddress.getHostAddress()
                                    + " is reachable through "
                                    + hotspotInterface.getName());
                    return true;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Unable to inspect the hotspot route", e);
        }
        return false;
    }

    /** Returns the active hotspot interface and its addresses, or {@code null} when inactive. */
    public static HotspotInterface getActiveHotspotInterface() {
        try {
            NetworkInterface networkInterface = findActiveHotspotNetworkInterface();
            if (networkInterface == null) {
                return null;
            }
            List<InetAddress> addresses = Collections.list(networkInterface.getInetAddresses());
            addresses.removeIf(
                    address -> address.isLoopbackAddress() || address.isLinkLocalAddress());
            if (addresses.isEmpty()) {
                return null;
            }
            return new HotspotInterface(networkInterface.getName(), addresses);
        } catch (Exception e) {
            Log.w(TAG, "Unable to inspect the active hotspot interface", e);
            return null;
        }
    }

    private static NetworkInterface findActiveHotspotNetworkInterface() throws Exception {
        NetworkInterface canonical =
                NetworkInterface.getByName(AsgConstants.MENTRA_LIVE_HOTSPOT_INTERFACE);
        if (isActiveHotspotInterface(canonical)) {
            return canonical;
        }

        Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
        while (interfaces != null && interfaces.hasMoreElements()) {
            NetworkInterface candidate = interfaces.nextElement();
            if (candidate.getName().startsWith("ap") && isActiveHotspotInterface(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private static boolean isActiveHotspotInterface(NetworkInterface networkInterface)
            throws Exception {
        if (networkInterface == null || !networkInterface.isUp()) {
            return false;
        }
        for (InterfaceAddress interfaceAddress : networkInterface.getInterfaceAddresses()) {
            if (interfaceAddress.getAddress() instanceof Inet4Address) {
                return true;
            }
        }
        return false;
    }

    static Inet4Address parseIpv4Endpoint(String endpointUrl) {
        try {
            String host = URI.create(endpointUrl).getHost();
            if (host == null) {
                return null;
            }
            String[] octets = host.split("\\.", -1);
            if (octets.length != 4) {
                return null;
            }
            byte[] address = new byte[4];
            for (int i = 0; i < octets.length; i++) {
                int value = Integer.parseInt(octets[i]);
                if (value < 0 || value > 255) {
                    return null;
                }
                address[i] = (byte) value;
            }
            return (Inet4Address) InetAddress.getByAddress(address);
        } catch (Exception e) {
            return null;
        }
    }

    static boolean isAddressInSubnet(
            Inet4Address candidate, Inet4Address localAddress, short prefixLength) {
        if (prefixLength < 0 || prefixLength > 32) {
            return false;
        }
        byte[] candidateBytes = candidate.getAddress();
        byte[] localBytes = localAddress.getAddress();
        int fullBytes = prefixLength / 8;
        int remainingBits = prefixLength % 8;
        for (int i = 0; i < fullBytes; i++) {
            if (candidateBytes[i] != localBytes[i]) {
                return false;
            }
        }
        if (remainingBits == 0) {
            return true;
        }
        int mask = 0xff << (8 - remainingBits);
        return (candidateBytes[fullBytes] & mask) == (localBytes[fullBytes] & mask);
    }
}
