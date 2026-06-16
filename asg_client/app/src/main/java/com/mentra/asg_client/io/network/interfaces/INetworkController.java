package com.mentra.asg_client.io.network.interfaces;

/**
 * Network control for WiFi and hotspot. Mentra Live may use privileged broadcasts; generic devices
 * use public Android APIs via {@link
 * com.mentra.asg_client.io.network.managers.SystemNetworkManager} or {@link
 * com.mentra.asg_client.io.network.managers.FallbackNetworkManager}.
 */
public interface INetworkController extends INetworkManager {}
