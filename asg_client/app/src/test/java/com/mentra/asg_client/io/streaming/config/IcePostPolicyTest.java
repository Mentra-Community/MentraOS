package com.mentra.asg_client.io.streaming.config;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.mentra.asg_client.io.streaming.config.IcePostPolicy.Decision;
import com.mentra.asg_client.io.streaming.config.IcePostPolicy.Mode;
import com.mentra.asg_client.io.streaming.config.IcePostPolicy.Trigger;
import org.junit.Test;

public class IcePostPolicyTest {

    // ---------------------------------------------------------------
    // Default STUN mode keeps all three triggers
    // ---------------------------------------------------------------

    @Test
    public void stunMode_postsOnSrflx() {
        assertEquals(Decision.POST, IcePostPolicy.decide(Mode.STUN, Trigger.SRFLX, false));
    }

    @Test
    public void stunMode_postsOnTimeout() {
        assertEquals(Decision.POST, IcePostPolicy.decide(Mode.STUN, Trigger.TIMEOUT, false));
    }

    @Test
    public void stunMode_postsOnGatheringComplete() {
        assertEquals(
                Decision.POST, IcePostPolicy.decide(Mode.STUN, Trigger.GATHERING_COMPLETE, false));
    }

    @Test
    public void stunMode_armsTheGatherTimeout() {
        assertTrue(IcePostPolicy.schedulesGatherTimeout(Mode.STUN));
    }

    // ---------------------------------------------------------------
    // Host-only mode posts only on a completed gather
    // ---------------------------------------------------------------

    @Test
    public void hostOnly_ignoresTheSrflxTrigger() {
        assertEquals(Decision.WAIT, IcePostPolicy.decide(Mode.HOST_ONLY, Trigger.SRFLX, true));
    }

    @Test
    public void hostOnly_ignoresTheGatherTimeout() {
        assertEquals(Decision.WAIT, IcePostPolicy.decide(Mode.HOST_ONLY, Trigger.TIMEOUT, true));
    }

    @Test
    public void hostOnly_neverArmsTheGatherTimeout() {
        assertFalse(IcePostPolicy.schedulesGatherTimeout(Mode.HOST_ONLY));
    }

    @Test
    public void hostOnly_postsOnCompleteWithAHotspotCandidate() {
        assertEquals(
                Decision.POST,
                IcePostPolicy.decide(Mode.HOST_ONLY, Trigger.GATHERING_COMPLETE, true));
    }

    @Test
    public void hostOnly_failsOnCompleteWithoutAHotspotCandidate() {
        assertEquals(
                Decision.FAIL_NO_HOTSPOT_CANDIDATE,
                IcePostPolicy.decide(Mode.HOST_ONLY, Trigger.GATHERING_COMPLETE, false));
    }

    @Test
    public void failureReasonIsStable() {
        assertEquals("no_hotspot_candidate", IcePostPolicy.REASON_NO_HOTSPOT_CANDIDATE);
    }

    // ---------------------------------------------------------------
    // Mode resolution
    // ---------------------------------------------------------------

    @Test
    public void modeIsHostOnlyWhenNoStunServerIsConfigured() {
        assertEquals(Mode.HOST_ONLY, IcePostPolicy.modeForStunServer(""));
        assertEquals(Mode.HOST_ONLY, IcePostPolicy.modeForStunServer("   "));
        assertEquals(Mode.HOST_ONLY, IcePostPolicy.modeForStunServer(null));
    }

    @Test
    public void modeIsStunWhenAServerIsConfigured() {
        assertEquals(Mode.STUN, IcePostPolicy.modeForStunServer("stun:stun.cloudflare.com:3478"));
    }

    // ---------------------------------------------------------------
    // Hotspot host candidate recognition
    // ---------------------------------------------------------------

    @Test
    public void recognisesTheGlassesHotspotHostCandidate() {
        assertTrue(
                IcePostPolicy.isHotspotHostCandidate(
                        "candidate:1 1 udp 2130706431 192.168.43.1 54321 typ host"));
    }

    @Test
    public void recognisesOtherPrivateRangesSoADifferentApSubnetStillPasses() {
        assertTrue(
                IcePostPolicy.isHotspotHostCandidate(
                        "candidate:1 1 udp 2130706431 10.0.0.5 54321 typ host"));
        assertTrue(
                IcePostPolicy.isHotspotHostCandidate(
                        "candidate:1 1 udp 2130706431 172.20.1.4 54321 typ host"));
    }

    @Test
    public void rejectsAReflexiveCandidateEvenOnAPrivateAddress() {
        assertFalse(
                IcePostPolicy.isHotspotHostCandidate(
                        "candidate:2 1 udp 1694498815 192.168.43.1 54321 typ srflx"));
    }

    @Test
    public void rejectsAHostCandidateOnAPublicAddress() {
        assertFalse(
                IcePostPolicy.isHotspotHostCandidate(
                        "candidate:1 1 udp 2130706431 203.0.113.7 54321 typ host"));
    }

    @Test
    public void rejectsIpv6AndMdnsObfuscatedCandidates() {
        assertFalse(
                IcePostPolicy.isHotspotHostCandidate(
                        "candidate:1 1 udp 2130706431 fe80::1 54321 typ host"));
        assertFalse(
                IcePostPolicy.isHotspotHostCandidate(
                        "candidate:1 1 udp 2130706431 abcd-efgh.local 54321 typ host"));
    }

    @Test
    public void rejectsNullAndEmpty() {
        assertFalse(IcePostPolicy.isHotspotHostCandidate(null));
        assertFalse(IcePostPolicy.isHotspotHostCandidate(""));
    }

    @Test
    public void privateIpv4BoundariesAreExact() {
        assertTrue(IcePostPolicy.isPrivateIpv4("10.0.0.0"));
        assertTrue(IcePostPolicy.isPrivateIpv4("172.16.0.1"));
        assertTrue(IcePostPolicy.isPrivateIpv4("172.31.255.255"));
        assertTrue(IcePostPolicy.isPrivateIpv4("192.168.0.1"));

        assertFalse(IcePostPolicy.isPrivateIpv4("11.0.0.0"));
        assertFalse(IcePostPolicy.isPrivateIpv4("172.15.0.1"));
        assertFalse(IcePostPolicy.isPrivateIpv4("172.32.0.1"));
        assertFalse(IcePostPolicy.isPrivateIpv4("192.169.0.1"));
        assertFalse(IcePostPolicy.isPrivateIpv4("999.1.1.1"));
        assertFalse(IcePostPolicy.isPrivateIpv4("not.an.ip.addr"));
        assertFalse(IcePostPolicy.isPrivateIpv4("192.168.1"));
    }
}
