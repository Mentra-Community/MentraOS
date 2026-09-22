package com.mentra.glassesmedia.network

/** Separate registrations keep a receiver from replacing the call owner's live network supplier. */
internal class ScopedNetworkRegistry<T : Any> {
  private var acs: () -> T? = { null }
  private var receiver: T? = null
  private var relay: T? = null

  @Synchronized fun registerAcs(supplier: () -> T?) { acs = supplier }
  @Synchronized fun registerReceiver(network: T) { receiver = network }
  @Synchronized fun releaseReceiver(network: T) { if (receiver === network) receiver = null }
  @Synchronized fun registerRelay(network: T) { relay = network }
  @Synchronized fun releaseRelay(network: T) { if (relay === network) relay = null }
  @Synchronized fun current(): T? = relay ?: acs() ?: receiver
  @Synchronized fun includesInternet(): Boolean = relay != null
}
