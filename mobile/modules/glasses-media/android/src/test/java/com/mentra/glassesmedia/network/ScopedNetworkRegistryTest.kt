package com.mentra.glassesmedia.network

import org.junit.Assert.*
import org.junit.Test

class ScopedNetworkRegistryTest {
  @Test fun `relay receiver cannot replace the live ACS supplier after teardown`() {
    val registry = ScopedNetworkRegistry<Any>()
    var acs: Any? = null
    registry.registerAcs { acs }
    val relay = Any()
    registry.registerRelay(relay)
    registry.registerReceiver(relay)
    assertSame(relay, registry.current())
    assertTrue(registry.includesInternet())
    registry.releaseReceiver(relay)
    registry.releaseRelay(relay)
    assertNull(registry.current())
    acs = Any()
    assertSame(acs, registry.current())
    assertFalse(registry.includesInternet())
    acs = Any() // A later call supplies a new network without reinstalling the monitor.
    assertSame(acs, registry.current())
  }

  @Test fun `late teardown cannot unregister a replacement session`() {
    val registry = ScopedNetworkRegistry<Any>()
    val old = Any()
    val next = Any()
    registry.registerReceiver(old)
    registry.registerRelay(old)
    registry.registerReceiver(next)
    registry.registerRelay(next)
    registry.releaseReceiver(old)
    registry.releaseRelay(old)
    assertSame(next, registry.current())
    assertTrue(registry.includesInternet())
  }
}
