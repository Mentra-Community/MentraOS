package com.mentra.crust.receivers

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class IncidentReportDeliveryTest {
  private val request = mapOf<String, Any>("alert_id" to "request-1")

  @Test
  fun refusesRequestBeforeCrustIsCreated() {
    val delivery = IncidentReportDelivery()
    delivery.setServiceReady(true)
    assertFalse(delivery.deliver(request))
  }

  @Test
  fun refusesRequestAfterCrustIsCreatedButBeforeReportServiceSubscribes() {
    val emitted = mutableListOf<Map<String, Any>>()
    val delivery = IncidentReportDelivery()
    delivery.attach { emitted.add(it) }
    assertFalse(delivery.deliver(request))
    assertTrue(emitted.isEmpty())
  }

  @Test
  fun deliversWhileReportServiceIsSubscribed() {
    val emitted = mutableListOf<Map<String, Any>>()
    val delivery = IncidentReportDelivery()
    delivery.attach { emitted.add(it) }
    delivery.setServiceReady(true)
    assertTrue(delivery.deliver(request))
    assertEquals(listOf(request), emitted)
  }

  @Test
  fun refusedRequestsAreNotReplayedWhenTheServiceStarts() {
    val emitted = mutableListOf<Map<String, Any>>()
    val delivery = IncidentReportDelivery()
    delivery.attach { emitted.add(it) }
    assertFalse(delivery.deliver(request))
    delivery.setServiceReady(true)
    assertTrue(emitted.isEmpty())
  }

  @Test
  fun serviceStopAndRestartGateDelivery() {
    val emitted = mutableListOf<Map<String, Any>>()
    val delivery = IncidentReportDelivery()
    delivery.attach { emitted.add(it) }
    delivery.setServiceReady(true)
    delivery.setServiceReady(false)
    assertFalse(delivery.deliver(request))
    delivery.setServiceReady(true)
    assertTrue(delivery.deliver(request))
    assertEquals(1, emitted.size)
  }

  @Test
  fun crustRecreationRequiresTheNewRuntimeToSubscribe() {
    val emitted = mutableListOf<Map<String, Any>>()
    val delivery = IncidentReportDelivery()
    delivery.attach { emitted.add(it) }
    delivery.setServiceReady(true)
    delivery.detach()
    assertFalse(delivery.deliver(request))
    delivery.attach { emitted.add(it) }
    assertFalse(delivery.deliver(request))
    assertTrue(emitted.isEmpty())
  }

  @Test
  fun emitterFailureIsReportedAsUndelivered() {
    val delivery = IncidentReportDelivery()
    delivery.attach { throw IllegalStateException("bridge gone") }
    delivery.setServiceReady(true)
    assertFalse(delivery.deliver(request))
  }
}
