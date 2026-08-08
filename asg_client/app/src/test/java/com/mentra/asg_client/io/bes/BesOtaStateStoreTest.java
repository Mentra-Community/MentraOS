package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.bes.BesOtaStateStore.Snapshot;
import com.mentra.asg_client.io.bes.BesOtaStateStore.StartDecision;
import com.mentra.asg_client.io.bes.BesOtaStateStore.StartupDecision;
import com.mentra.asg_client.io.bes.BesOtaStateStore.State;
import com.mentra.asg_client.io.bes.BesOtaStateStore.TerminalStatus;
import com.mentra.asg_client.io.bes.BesOtaStateStore.TransitionResult;
import com.mentra.asg_client.io.bes.BesOtaStateStore.UartPolicy;
import com.mentra.asg_client.io.bes.BesOtaStateStore.VerificationDecision;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesOtaStateStoreTest {
    private static final String OWNER = "session-a";
    private static final String OTHER_OWNER = "session-b";
    private static final String BOOT_A = "boot-a";
    private static final String BOOT_B = "boot-b";
    private static final String BOOT_C = "boot-c";
    private static final String TARGET = "26.7.30.4";
    private static final String ARTIFACT = "bes-26.7.30.4-update_ota.bin";
    private static final String SHA =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    private FakeStorage storage;
    private FakeBootIdProvider bootIds;
    private BesOtaStateStore store;

    @Before
    public void setUp() {
        storage = new FakeStorage();
        bootIds = new FakeBootIdProvider(BOOT_A);
        store = new BesOtaStateStore(storage, bootIds);
    }

    @Test
    public void absentRecordIsIdleAndNormal() {
        assertThat(store.read().isIdle()).isTrue();
        assertThat(store.uartPolicy(BOOT_A, false, null)).isEqualTo(UartPolicy.NORMAL);
        assertThat(store.prepareForNewSession(BOOT_A, false)).isEqualTo(StartDecision.ADMIT);
    }

    @Test
    public void reservationCommitsOneAuthorizationOwnerAndBoot() {
        assertThat(reserve()).isEqualTo(TransitionResult.APPLIED);

        Snapshot snapshot = store.read();
        assertThat(snapshot.getState()).isEqualTo(State.AUTH_ATTEMPTED);
        assertThat(snapshot.getOwnerSessionId()).isEqualTo(OWNER);
        assertThat(snapshot.getAuthorizationBootId()).isEqualTo(BOOT_A);
        assertThat(snapshot.getTargetVersion()).isEqualTo(TARGET);
        assertThat(store.uartPolicy(BOOT_A, false, OWNER)).isEqualTo(UartPolicy.OTA_OWNER_ONLY);
    }

    @Test
    public void duplicateReservationInSameOrLaterBootIsRejected() {
        assertThat(reserve()).isEqualTo(TransitionResult.APPLIED);

        assertThat(reserve()).isEqualTo(TransitionResult.REJECTED);
        assertThat(store.reserveAuthorization(OTHER_OWNER, BOOT_B, TARGET, ARTIFACT, SHA))
                .isEqualTo(TransitionResult.REJECTED);
    }

    @Test
    public void reservationCommitFailureConsumesNoAuthorizationInStorage() {
        storage.failNextPut = true;

        assertThat(reserve()).isEqualTo(TransitionResult.PERSISTENCE_FAILURE);
        assertThat(storage.raw).isNull();
        assertThat(store.read().isCorrupt()).isTrue();
        assertThat(store.uartPolicy(BOOT_A, false, OWNER)).isEqualTo(UartPolicy.QUARANTINED);
    }

    @Test
    public void applyRequiresExpectedOwnerAndState() {
        reserve();

        assertThat(store.markApplyPending(OTHER_OWNER)).isEqualTo(TransitionResult.REJECTED);
        assertThat(store.markApplyPending(OWNER)).isEqualTo(TransitionResult.APPLIED);
        assertThat(store.markApplyPending(OWNER)).isEqualTo(TransitionResult.REJECTED);
        assertThat(store.read().getState()).isEqualTo(State.APPLY_PENDING);
    }

    @Test
    public void firstPostApplyBootIsClaimedAndSameBootCanResume() {
        reserveAndMarkApply();

        assertThat(store.claimOrResumeVerificationBoot(BOOT_A))
                .isEqualTo(VerificationDecision.WAIT_FOR_REBOOT);
        assertThat(store.claimOrResumeVerificationBoot(BOOT_B))
                .isEqualTo(VerificationDecision.CLAIMED);
        assertThat(store.claimOrResumeVerificationBoot(BOOT_B))
                .isEqualTo(VerificationDecision.RESUME);
        assertThat(store.read().getVerificationBootId()).isEqualTo(BOOT_B);
    }

    @Test
    public void secondUnverifiedBootBecomesMonotonicFailure() {
        reserveAndMarkApply();
        store.claimOrResumeVerificationBoot(BOOT_B);

        assertThat(store.claimOrResumeVerificationBoot(BOOT_C))
                .isEqualTo(VerificationDecision.SECOND_BOOT_FAILED);
        assertThat(store.read().getState()).isEqualTo(State.TERMINAL);
        assertThat(store.read().getTerminalStatus()).isEqualTo(TerminalStatus.FAILURE);
        assertThat(store.read().getTerminalCode()).isEqualTo("verification_boot_changed");
    }

    @Test
    public void exactClaimedBootAndVersionAreRequiredForSuccess() {
        reserveAndMarkApply();
        store.claimOrResumeVerificationBoot(BOOT_B);

        assertThat(store.completeVerified(OWNER, BOOT_A, TARGET))
                .isEqualTo(TransitionResult.REJECTED);
        assertThat(store.completeVerified(OTHER_OWNER, BOOT_B, TARGET))
                .isEqualTo(TransitionResult.REJECTED);
        assertThat(store.completeVerified(OWNER, BOOT_B, TARGET))
                .isEqualTo(TransitionResult.APPLIED);
        assertThat(store.read().getTerminalStatus()).isEqualTo(TerminalStatus.SUCCESS);
    }

    @Test
    public void unexpectedNewerVersionIsStillFailure() {
        reserveAndMarkApply();
        store.claimOrResumeVerificationBoot(BOOT_B);

        assertThat(store.completeVerified(OWNER, BOOT_B, "26.7.31.0"))
                .isEqualTo(TransitionResult.APPLIED);
        assertThat(store.read().getTerminalStatus()).isEqualTo(TerminalStatus.FAILURE);
        assertThat(store.read().getTerminalCode()).isEqualTo("version_mismatch");
    }

    @Test
    public void terminalFailureIsIdempotentButCannotBeFlipped() {
        reserve();
        assertThat(store.fail(OWNER, "authorization_denied")).isEqualTo(TransitionResult.APPLIED);

        assertThat(store.fail(OWNER, "response_timeout"))
                .isEqualTo(TransitionResult.ALREADY_TERMINAL);
        assertThat(store.fail(OTHER_OWNER, "response_timeout"))
                .isEqualTo(TransitionResult.REJECTED);
        assertThat(store.read().getTerminalCode()).isEqualTo("authorization_denied");
    }

    @Test
    public void failedTerminalCannotRetireInAuthorizationBoot() {
        reserve();
        store.fail(OWNER, "install_failed");

        assertThat(store.prepareForNewSession(BOOT_A, true))
                .isEqualTo(StartDecision.RESTART_REQUIRED);
        assertThat(store.read().isValid()).isTrue();
    }

    @Test
    public void failedTerminalRequiresNewBootAndFramedProofBeforeRetirement() {
        reserve();
        store.fail(OWNER, "install_failed");

        assertThat(store.prepareForNewSession(BOOT_B, false))
                .isEqualTo(StartDecision.PATH_PROOF_REQUIRED);
        ShadowLog.clear();
        assertThat(store.prepareForNewSession(BOOT_B, true)).isEqualTo(StartDecision.ADMIT);
        assertThat(store.read().isIdle()).isTrue();
        assertThat(logsContain("op=retire_failure_after_path_proof", "after={state=IDLE}"))
                .isTrue();
    }

    @Test
    public void successfulTerminalCanRetireWithoutAnotherBoot() {
        completeSuccessfully();

        ShadowLog.clear();
        assertThat(store.prepareForNewSession(BOOT_B, false)).isEqualTo(StartDecision.ADMIT);
        assertThat(store.read().isIdle()).isTrue();
        assertThat(logsContain("op=retire_success", "after={state=IDLE}")).isTrue();
    }

    @Test
    public void activeHardwareCannotBeSupersededByNewStart() {
        reserve();
        assertThat(store.prepareForNewSession(BOOT_A, true)).isEqualTo(StartDecision.ACTIVE);
        store.markApplyPending(OWNER);
        assertThat(store.prepareForNewSession(BOOT_B, true)).isEqualTo(StartDecision.ACTIVE);
    }

    @Test
    public void sameBootProcessRestartRecordsFailureAndRequiresFramedRecoveryProof() {
        reserve();

        assertThat(store.reconcileStartup(BOOT_A)).isEqualTo(StartupDecision.RECOVERY_PROBE_ONLY);
        assertThat(store.read().getState()).isEqualTo(State.TERMINAL);
        assertThat(store.read().getTerminalCode()).isEqualTo("interrupted");
        assertThat(store.uartPolicy(BOOT_A, false, null))
                .isEqualTo(UartPolicy.RECOVERY_PROBE_ONLY);
        assertThat(store.uartPolicy(BOOT_A, true, null)).isEqualTo(UartPolicy.NORMAL);
        assertThat(store.prepareForNewSession(BOOT_A, true))
                .isEqualTo(StartDecision.RESTART_REQUIRED);
    }

    @Test
    public void sameBootTerminalFailureAllowsOnlyOrdinaryUartAfterFramedProof() {
        reserve();
        assertThat(store.fail(OWNER, "response_timeout")).isEqualTo(TransitionResult.APPLIED);

        assertThat(store.uartPolicy(BOOT_A, false, null))
                .isEqualTo(UartPolicy.RECOVERY_PROBE_ONLY);
        assertThat(store.uartPolicy(BOOT_A, true, null)).isEqualTo(UartPolicy.NORMAL);
        assertThat(store.prepareForNewSession(BOOT_A, true))
                .isEqualTo(StartDecision.RESTART_REQUIRED);
    }

    @Test
    public void laterBootProcessRestartRequiresRecoveryProof() {
        reserve();

        assertThat(store.reconcileStartup(BOOT_B)).isEqualTo(StartupDecision.RECOVERY_PROBE_ONLY);
        assertThat(store.read().getState()).isEqualTo(State.AUTH_ATTEMPTED);
        assertThat(store.uartPolicy(BOOT_B, false, null)).isEqualTo(UartPolicy.RECOVERY_PROBE_ONLY);
        assertThat(store.uartPolicy(BOOT_B, true, null)).isEqualTo(UartPolicy.RECOVERY_PROBE_ONLY);
    }

    @Test
    public void exactVersionResolvesLaterBootAuthorizationAsSuccess() {
        reserve();
        assertThat(store.reconcileStartup(BOOT_B)).isEqualTo(StartupDecision.RECOVERY_PROBE_ONLY);

        assertThat(store.completeRecoveredAfterRestart(OWNER, BOOT_B, TARGET))
                .isEqualTo(TransitionResult.APPLIED);
        assertThat(store.read().getState()).isEqualTo(State.TERMINAL);
        assertThat(store.read().getTerminalStatus()).isEqualTo(TerminalStatus.SUCCESS);
        assertThat(store.read().getTerminalCode()).isEqualTo("verified");
        assertThat(store.read().getVerificationBootId()).isEqualTo(BOOT_B);
        assertThat(store.uartPolicy(BOOT_B, true, null)).isEqualTo(UartPolicy.NORMAL);
    }

    @Test
    public void differentVersionResolvesLaterBootAuthorizationAsFailure() {
        reserve();

        assertThat(store.completeRecoveredAfterRestart(OWNER, BOOT_B, "26.7.30.3"))
                .isEqualTo(TransitionResult.APPLIED);
        assertThat(store.read().getTerminalStatus()).isEqualTo(TerminalStatus.FAILURE);
        assertThat(store.read().getTerminalCode()).isEqualTo("version_mismatch");
    }

    @Test
    public void invalidVersionProofResolvesLaterBootAuthorizationAsFailure() {
        reserve();

        assertThat(store.completeRecoveredAfterRestart(OWNER, BOOT_B, "unknown"))
                .isEqualTo(TransitionResult.APPLIED);
        assertThat(store.read().getTerminalStatus()).isEqualTo(TerminalStatus.FAILURE);
        assertThat(store.read().getTerminalCode()).isEqualTo("invalid_version_proof");
    }

    @Test
    public void recoveredVersionProofRequiresOwnerAndLaterBoot() {
        reserve();

        assertThat(store.completeRecoveredAfterRestart(OTHER_OWNER, BOOT_B, TARGET))
                .isEqualTo(TransitionResult.REJECTED);
        assertThat(store.completeRecoveredAfterRestart(OWNER, BOOT_A, TARGET))
                .isEqualTo(TransitionResult.REJECTED);
        assertThat(store.read().getState()).isEqualTo(State.AUTH_ATTEMPTED);
    }

    @Test
    public void postApplyStartupClaimsOnlyFirstVerificationBoot() {
        reserveAndMarkApply();

        assertThat(store.reconcileStartup(BOOT_A)).isEqualTo(StartupDecision.APPLY_WAIT);
        assertThat(store.reconcileStartup(BOOT_B)).isEqualTo(StartupDecision.VERSION_PROBE_ONLY);
        assertThat(store.reconcileStartup(BOOT_B)).isEqualTo(StartupDecision.VERSION_PROBE_ONLY);
        assertThat(store.reconcileStartup(BOOT_C)).isEqualTo(StartupDecision.QUARANTINED);
    }

    @Test
    public void corruptAndUnknownSchemaFailClosedAndCanBeRepaired() throws Exception {
        storage.raw = "{not-json";
        assertThat(store.read().isCorrupt()).isTrue();
        assertThat(store.prepareForNewSession(BOOT_A, true)).isEqualTo(StartDecision.CORRUPT);
        assertThat(store.reconcileStartup(BOOT_A)).isEqualTo(StartupDecision.QUARANTINED);
        assertThat(store.read().getTerminalCode()).isEqualTo("corrupt_state");

        JSONObject unknown = new JSONObject(storage.raw);
        unknown.put("schema", 99);
        FakeStorage secondStorage = new FakeStorage();
        secondStorage.raw = unknown.toString();
        BesOtaStateStore second =
                new BesOtaStateStore(secondStorage, new FakeBootIdProvider(BOOT_A));
        assertThat(second.read().isCorrupt()).isTrue();
    }

    @Test
    public void blankPersistedRecordIsCorruptNotIdle() {
        storage.raw = "   ";

        assertThat(store.read().isCorrupt()).isTrue();
        assertThat(store.prepareForNewSession(BOOT_A, true)).isEqualTo(StartDecision.CORRUPT);
        assertThat(store.uartPolicy(BOOT_A, true, null)).isEqualTo(UartPolicy.QUARANTINED);
    }

    @Test
    public void malformedPersistedVerificationBootCannotBeClaimedAgain() throws Exception {
        reserveAndMarkApply();
        JSONObject persisted = new JSONObject(storage.raw);
        persisted.put("verification_boot_id", "   ");
        storage.raw = persisted.toString();

        assertThat(store.read().isCorrupt()).isTrue();
        assertThat(store.claimOrResumeVerificationBoot(BOOT_B))
                .isEqualTo(VerificationDecision.NOT_PENDING);
        assertThat(store.uartPolicy(BOOT_B, true, null)).isEqualTo(UartPolicy.QUARANTINED);
    }

    @Test
    public void failedTransitionCommitDoesNotErasePreviousStoredRecord() {
        reserve();
        String reserved = storage.raw;
        storage.failNextPut = true;

        assertThat(store.markApplyPending(OWNER)).isEqualTo(TransitionResult.PERSISTENCE_FAILURE);
        assertThat(storage.raw).isEqualTo(reserved);
        assertThat(store.read().isCorrupt()).isTrue();
    }

    @Test
    public void successfulCommitWithStaleImmediateReadbackIsDiagnosed() {
        reserve();
        ShadowLog.clear();
        storage.dropNextSuccessfulPut = true;

        assertThat(store.markApplyPending(OWNER)).isEqualTo(TransitionResult.APPLIED);
        assertThat(store.read().getState()).isEqualTo(State.AUTH_ATTEMPTED);
        assertThat(logsContain("op=mark_apply_pending", "readback_match=false")).isTrue();
    }

    @Test
    public void diagnosticStateSummaryOmitsArtifactIdentityAndDigest() {
        reserve();

        String summary = store.read().toDiagnosticString();
        assertThat(summary).contains("state=AUTH_ATTEMPTED", "target=" + TARGET);
        assertThat(summary).doesNotContain(ARTIFACT, SHA);
    }

    @Test
    public void versionCanonicalizationIsExactAndBounded() {
        assertThat(BesOtaStateStore.canonicalVersion("026.007.030.004")).isEqualTo("26.7.30.4");
        assertThat(BesOtaStateStore.canonicalVersion("26.7.30")).isNull();
        assertThat(BesOtaStateStore.canonicalVersion("26.7.30.256")).isNull();
        assertThat(BesOtaStateStore.canonicalVersion("26.7.x.4")).isNull();
    }

    private TransitionResult reserve() {
        return store.reserveAuthorization(OWNER, BOOT_A, TARGET, ARTIFACT, SHA);
    }

    private void reserveAndMarkApply() {
        assertThat(reserve()).isEqualTo(TransitionResult.APPLIED);
        assertThat(store.markApplyPending(OWNER)).isEqualTo(TransitionResult.APPLIED);
    }

    private void completeSuccessfully() {
        reserveAndMarkApply();
        assertThat(store.claimOrResumeVerificationBoot(BOOT_B))
                .isEqualTo(VerificationDecision.CLAIMED);
        assertThat(store.completeVerified(OWNER, BOOT_B, TARGET))
                .isEqualTo(TransitionResult.APPLIED);
    }

    private static boolean logsContain(String first, String second) {
        for (ShadowLog.LogItem item : ShadowLog.getLogsForTag("BesOtaStateStore")) {
            if (item.msg.contains(first) && item.msg.contains(second)) {
                return true;
            }
        }
        return false;
    }

    private static final class FakeStorage implements BesOtaStateStore.Storage {
        String raw;
        boolean failNextPut;
        boolean failNextRemove;
        boolean dropNextSuccessfulPut;

        @Override
        public String get() {
            return raw;
        }

        @Override
        public boolean put(String value) {
            if (failNextPut) {
                failNextPut = false;
                return false;
            }
            if (dropNextSuccessfulPut) {
                dropNextSuccessfulPut = false;
                return true;
            }
            raw = value;
            return true;
        }

        @Override
        public boolean remove() {
            if (failNextRemove) {
                failNextRemove = false;
                return false;
            }
            raw = null;
            return true;
        }
    }

    private static final class FakeBootIdProvider implements BesOtaStateStore.BootIdProvider {
        String bootId;

        FakeBootIdProvider(String bootId) {
            this.bootId = bootId;
        }

        @Override
        public String currentBootId() {
            return bootId;
        }
    }
}
