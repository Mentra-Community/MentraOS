package com.mentra.bluetoothsdk.net

import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Best-effort local IPv4 discovery for phone-hosted servers the glasses reach over WiFi
 * (photo upload receiver, hotspot-served OTA). Prefers WiFi-ish interfaces carrying RFC1918
 * addresses — under a glasses-hotspot session wlan0 holds the 192.168.43.x client address.
 */
object LocalIpv4 {
  fun bestLocalIpv4Address(): String? {
    val wifiPrivateCandidates = mutableListOf<Inet4Address>()
    val wifiCandidates = mutableListOf<Inet4Address>()
    val privateCandidates = mutableListOf<Inet4Address>()
    val otherCandidates = mutableListOf<Inet4Address>()
    val interfaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
    for (networkInterface in interfaces) {
      if (!networkInterface.isUp || networkInterface.isLoopback) {
        continue
      }
      val addresses = networkInterface.inetAddresses.toList()
        .filterIsInstance<Inet4Address>()
        .filter { address ->
          !address.isLoopbackAddress &&
            !address.isLinkLocalAddress
        }
      if (isWifiInterface(networkInterface.name)) {
        wifiPrivateCandidates += addresses.filter { isPrivateIpv4(it.hostAddress.orEmpty()) }
        wifiCandidates += addresses
      } else {
        privateCandidates += addresses.filter { isPrivateIpv4(it.hostAddress.orEmpty()) }
        otherCandidates += addresses
      }
    }

    return (
      wifiPrivateCandidates.firstOrNull() ?:
        wifiCandidates.firstOrNull() ?:
        privateCandidates.firstOrNull() ?:
        otherCandidates.firstOrNull()
      )?.hostAddress
  }

  private fun isWifiInterface(name: String): Boolean {
    return name.startsWith("wlan") ||
      name.startsWith("p2p") ||
      name.startsWith("ap") ||
      name.startsWith("swlan")
  }

  private fun isPrivateIpv4(host: String): Boolean {
    return host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      host.matches(Regex("^172\\.(1[6-9]|2[0-9]|3[0-1])\\..*"))
  }
}
