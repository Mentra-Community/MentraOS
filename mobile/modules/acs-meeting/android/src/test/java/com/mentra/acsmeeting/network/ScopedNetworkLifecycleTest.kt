package com.mentra.acsmeeting.network

import com.mentra.acsmeeting.network.ScopedNetworkState.Failure
import com.mentra.acsmeeting.network.ScopedNetworkState.Phase
import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

/**
 * ConnectivityManager gives no ordering or at-most-once guarantee, so these cover the awkward
 * orderings that would otherwise only show up on a device: duplicate callbacks, a callback from a
 * request that was already replaced, and a timeout racing a late onAvailable.
 */
class ScopedNetworkLifecycleTest {

    @Test
    fun `starts idle`() {
        val state = ScopedNetworkState()
        assertThat(state.phase).isEqualTo(Phase.IDLE)
        assertThat(state.failure).isEqualTo(Failure.NONE)
        assertThat(state.isActive).isFalse()
    }

    @Test
    fun `happy path is idle to requesting to available`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()
        assertThat(state.phase).isEqualTo(Phase.REQUESTING)

        assertThat(state.onAvailable(generation)).isTrue()
        assertThat(state.phase).isEqualTo(Phase.AVAILABLE)
        assertThat(state.failure).isEqualTo(Failure.NONE)
    }

    @Test
    fun `a duplicate onAvailable does not re-transition`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()

        assertThat(state.onAvailable(generation)).isTrue()
        assertThat(state.onAvailable(generation)).isFalse()
        assertThat(state.phase).isEqualTo(Phase.AVAILABLE)
    }

    @Test
    fun `losing an available network reports LOST`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()
        state.onAvailable(generation)

        assertThat(state.onLost(generation)).isTrue()
        assertThat(state.phase).isEqualTo(Phase.LOST)
        assertThat(state.failure).isEqualTo(Failure.LOST)
    }

    @Test
    fun `a second onLost is a no-op`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()
        state.onAvailable(generation)
        state.onLost(generation)

        assertThat(state.onLost(generation)).isFalse()
    }

    @Test
    fun `timeout while still requesting fails as TIMEOUT`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()

        assertThat(state.onTimeout(generation)).isTrue()
        assertThat(state.phase).isEqualTo(Phase.LOST)
        assertThat(state.failure).isEqualTo(Failure.TIMEOUT)
    }

    /** The join succeeded just before the watchdog fired; the network must stay usable. */
    @Test
    fun `a timeout arriving after onAvailable is ignored`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()
        state.onAvailable(generation)

        assertThat(state.onTimeout(generation)).isFalse()
        assertThat(state.phase).isEqualTo(Phase.AVAILABLE)
        assertThat(state.failure).isEqualTo(Failure.NONE)
    }

    @Test
    fun `onUnavailable fails as UNAVAILABLE`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()

        assertThat(state.onUnavailable(generation)).isTrue()
        assertThat(state.failure).isEqualTo(Failure.UNAVAILABLE)
    }

    @Test
    fun `a SecurityException maps to PERMISSION_DENIED`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()

        assertThat(state.onRequestFailed(generation, permissionDenied = true)).isTrue()
        assertThat(state.failure).isEqualTo(Failure.PERMISSION_DENIED)
    }

    @Test
    fun `any other request throw maps to REQUEST_FAILED`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()

        assertThat(state.onRequestFailed(generation, permissionDenied = false)).isTrue()
        assertThat(state.failure).isEqualTo(Failure.REQUEST_FAILED)
    }

    // -----------------------------------------------------------------
    // Stale generations
    // -----------------------------------------------------------------

    @Test
    fun `callbacks from a superseded request are rejected`() {
        val state = ScopedNetworkState()
        val first = state.startRequest()
        val second = state.startRequest()
        assertThat(second).isNotEqualTo(first)

        assertThat(state.onAvailable(first)).isFalse()
        assertThat(state.onLost(first)).isFalse()
        assertThat(state.onUnavailable(first)).isFalse()
        assertThat(state.onTimeout(first)).isFalse()
        assertThat(state.phase).isEqualTo(Phase.REQUESTING)

        assertThat(state.onAvailable(second)).isTrue()
    }

    @Test
    fun `a late onLost after release does not resurrect state`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()
        state.onAvailable(generation)
        state.release()

        assertThat(state.onLost(generation)).isFalse()
        assertThat(state.failure).isEqualTo(Failure.NONE)
    }

    @Test
    fun `release is idempotent`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()
        state.onAvailable(generation)

        assertThat(state.release()).isTrue()
        assertThat(state.release()).isFalse()
    }

    @Test
    fun `release from idle is a no-op`() {
        assertThat(ScopedNetworkState().release()).isFalse()
    }

    @Test
    fun `reset returns the machine to idle for reuse`() {
        val state = ScopedNetworkState()
        val generation = state.startRequest()
        state.onLost(generation)
        state.reset()

        assertThat(state.phase).isEqualTo(Phase.IDLE)
        assertThat(state.failure).isEqualTo(Failure.NONE)

        val next = state.startRequest()
        assertThat(state.onAvailable(next)).isTrue()
    }

    /** Ten start/stop cycles must leave no residue, matching the rejoin soak requirement. */
    @Test
    fun `ten join and release cycles end clean`() {
        val state = ScopedNetworkState()
        repeat(10) {
            val generation = state.startRequest()
            assertThat(state.onAvailable(generation)).isTrue()
            assertThat(state.release()).isTrue()
            state.reset()
            assertThat(state.phase).isEqualTo(Phase.IDLE)
        }
        assertThat(state.generation).isEqualTo(10)
    }
}
