package com.augmentos.augmentos_core.smarterglassesmanager.utils;

import android.util.Log;

import java.net.DatagramSocket;
import java.net.DatagramPacket;

import android.net.wifi.WifiManager;
import java.net.InetAddress;
import android.content.Context;
import android.net.wifi.WifiInfo;
import android.util.Pair;

import java.lang.reflect.InvocationTargetException;
import java.util.ArrayList;
import java.util.Enumeration;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.net.InterfaceAddress;
import java.net.UnknownHostException;
import java.lang.reflect.Method;
import java.util.List;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

// see https://stackoverflow.com/questions/14080573/getting-wifi-broadcast-address-in-android-wifi-hotspot for much of this code
public class NetworkUtils {
    public static final String TAG = "WearableAi_NetworkUtils";

    public static void sendBroadcast(String messageStr, DatagramSocket adv_socket, int port, Context context){
        try {
            byte[] sendData = messageStr.getBytes();
            InetAddress my_ip;
            if (isHotspotOn(context)){
                String my_ip_hs = getHotspotIpAddress();
                my_ip = InetAddress.getByName(my_ip_hs);
            } else {
                my_ip = getIpAddress();
            }

            InetAddress bca_ip = getBroadcastAddress(my_ip);
            if (bca_ip == null){
                //this probably means we aren't connect to or hosting WiFi
                //but, some phones, even when wifi tether is on, need this, so let's try:
                my_ip = getIpAddress();
                bca_ip = getBroadcastAddress(my_ip);
                if (bca_ip == null){
                    Log.d(TAG, "Broadcast address is null");
                    return;
                }
            }

            DatagramPacket sendPacket = new DatagramPacket(sendData, sendData.length, bca_ip, port);
            adv_socket.send(sendPacket);
        } catch (IOException e){
            Log.d(TAG, "FAILED TO SEND BROADCAST");
            e.printStackTrace();
            return ;
        }
    }

    public static InetAddress getBroadcast(InetAddress inetAddr) {

        NetworkInterface temp;
        InetAddress iAddr = null;
        try {
            temp = NetworkInterface.getByInetAddress(inetAddr);
            List<InterfaceAddress> addresses = temp.getInterfaceAddresses();

            for (InterfaceAddress inetAddress: addresses)

                iAddr = inetAddress.getBroadcast();
            return iAddr;

        } catch (SocketException e) {

            e.printStackTrace();
        }
        return null;
    }

    public static boolean isHotspotOn(Context context){
        WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        Method[] wmMethods = wifi.getClass().getDeclaredMethods();
        for (Method method: wmMethods) {
            if (method.getName().equals("isWifiApEnabled")) {

                try {
                    if ((Boolean) method.invoke(wifi)) {
//                        isInetConnOn = true;
//                        iNetMode = 2;
                        return true;
                    } else {
                        return false;
                    }
                } catch (IllegalArgumentException e) {
                    e.printStackTrace();
                } catch (IllegalAccessException e) {
                    e.printStackTrace();
                } catch (InvocationTargetException e) {
                    e.printStackTrace();
                }

            }
        }
        return false;
    }

    public static InetAddress getIpAddress() {
      InetAddress inetAddress = null;
      InetAddress myAddr = null;

      try {
        for (Enumeration<NetworkInterface> networkInterface = NetworkInterface
          .getNetworkInterfaces(); networkInterface.hasMoreElements();) {

          NetworkInterface singleInterface = networkInterface.nextElement();

          for (Enumeration<InetAddress> IpAddresses = singleInterface.getInetAddresses(); IpAddresses
            .hasMoreElements();) {
            inetAddress = IpAddresses.nextElement();

            if (!inetAddress.isLoopbackAddress() && (singleInterface.getDisplayName()
                .contains("wlan0") ||
                singleInterface.getDisplayName().contains("eth0") ||
                singleInterface.getDisplayName().contains("ap0"))) {

              myAddr = inetAddress;
            }
          }
        }

      } catch (SocketException ex) {
        Log.e(TAG, ex.toString());
      }
      return myAddr;
    }

    public static String getHotspotIpAddress() {
            String ip = "";
            List<Pair<String, String>> ipAddys = new ArrayList<Pair<String, String>>();
            String [] hotspots = new String [] {"swlan", "ap", "wlan1", "wlan"};

            try {
                Enumeration<NetworkInterface> enumNetworkInterfaces = NetworkInterface
                        .getNetworkInterfaces();
                while (enumNetworkInterfaces.hasMoreElements()) {
                    NetworkInterface networkInterface = enumNetworkInterfaces
                            .nextElement();
                    Enumeration<InetAddress> enumInetAddress = networkInterface
                            .getInetAddresses();
                    while (enumInetAddress.hasMoreElements()) {
                        InetAddress inetAddress = enumInetAddress.nextElement();
                        if (inetAddress.isSiteLocalAddress()){
                            ip = inetAddress.getHostAddress();
                            ipAddys.add(new Pair(ip, networkInterface.getName()));
                        }
                    }
                }
            } catch (SocketException e) {
                // TODO Auto-generated catch block
                e.printStackTrace();
                return null;
            }

            //go through all the ip addresses and choose the one most likely to be the hotspot
            for (int i = 0; i < hotspots.length; i++) {
                for (int j = 0; j < ipAddys.size(); j++) {
                    if (ipAddys.get(j).second.contains(hotspots[i])){
                       return ipAddys.get(j).first;
                    }
                }
            }
            return ip;
    }

    public static InetAddress getBroadcastAddress(InetAddress inetAddr) {

        NetworkInterface temp;
        InetAddress iAddr = null;
        try {
            temp = NetworkInterface.getByInetAddress(inetAddr);
            List<InterfaceAddress> addresses = temp.getInterfaceAddresses();

            for (InterfaceAddress inetAddress: addresses)

                iAddr = inetAddress.getBroadcast();
            return iAddr;

        } catch (SocketException e) {

            e.printStackTrace();
            Log.d(TAG, "getBroadcast" + e.getMessage());
        } catch (NullPointerException e){
            Log.d(TAG, "Null pointer on getBroadcastAdress, probably means we arent' connected to wifi AND we don't have a live wifi hotspot");
            return null;
        }
        return null;
    }
 
     public static String getLocalIpAddress(Context context) throws UnknownHostException {
            WifiManager wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            assert wifiManager != null;
            WifiInfo wifiInfo = wifiManager.getConnectionInfo();
            int ipInt = wifiInfo.getIpAddress();
            return InetAddress.getByAddress(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(ipInt).array()).getHostAddress();
    }




}
