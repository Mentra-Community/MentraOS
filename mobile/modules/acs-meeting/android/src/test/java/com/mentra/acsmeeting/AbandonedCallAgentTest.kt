package com.mentra.acsmeeting

import java.util.concurrent.CompletableFuture
import java.util.concurrent.Future
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AbandonedCallAgentTest {

  @Test
  fun `a completed future still yields the agent after we stop waiting`() {
    val agent = Any()
    val pending: Future<Any> = CompletableFuture.completedFuture(agent)

    assertSame(agent, AbandonedCallAgent.takeIfDone(pending))
  }

  @Test
  fun `an incomplete future is left for a later sweep`() {
    val pending = CompletableFuture<Any>()

    assertNull(AbandonedCallAgent.takeIfDone(pending))
    assertFalse(pending.isCancelled)
  }

  @Test
  fun `a cancelled future cannot hand back the native agent`() {
    val pending = CompletableFuture<Any>()
    pending.cancel(true)

    assertTrue(pending.isCancelled)
    assertNull(AbandonedCallAgent.takeIfDone(pending))
  }

  @Test
  fun `a short wait returns the agent once the future completes`() {
    val agent = Any()
    val pending = CompletableFuture<Any>()
    pending.complete(agent)

    assertSame(agent, AbandonedCallAgent.take(pending, 50))
  }

  @Test
  fun `a short wait does not cancel an agent that is still signing in`() {
    val pending = CompletableFuture<Any>()

    assertNull(AbandonedCallAgent.take(pending, 20))
    assertFalse(pending.isDone)
    assertFalse(pending.isCancelled)
  }

  @Test
  fun `already-exists is recognized through wrapped execution exceptions`() {
    val native = IllegalStateException(
      "Failed to create CallAgent, an instance of CallAgent associated with this identity already exists.",
    )
    val wrapped = java.util.concurrent.ExecutionException(native)

    assertTrue(AbandonedCallAgent.isExistingAgentError(wrapped))
    assertFalse(AbandonedCallAgent.isExistingAgentError(IllegalStateException("ACS_AGENT_TIMEOUT")))
  }

  @Test
  fun `take with no wait is the same as takeIfDone`() {
    val pending = CompletableFuture<Any>()
    assertNull(AbandonedCallAgent.take(pending, 0))
    pending.complete("agent")
    assertSame("agent", AbandonedCallAgent.take(pending, 0))
  }
}
