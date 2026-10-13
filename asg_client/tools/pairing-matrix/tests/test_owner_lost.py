"""Unit tests for owner_lost.owner_lost_on_notice (plan section 7) with fakes. Scaled-down intervals."""

import time
import unittest

from tests import helpers as h  # noqa: E402
import owner_lost  # noqa: E402

# 20 s observation / 10 s card, scaled by 1/25 so each test runs about a second.
OBS, CARD = 0.5, 0.25
FAST = dict(observe_s=OBS, card_s=CARD, notice_timeout=2.0, rejection_timeout=2.0, bes_timeout=0.15,
            settle_s=0.03, ui_poll_s=0.03)


owner_lost.BES_POLL_S = 0.05


def run(ctx, probe, scenario="takeover", during=None, new_owner_bond=None, **kw):
    t_start = {}

    def trigger():
        probe.fire()
        t_start["t"] = time.time()

    params = dict(FAST)
    params.update(kw)
    res = owner_lost.owner_lost_on_notice(
        ctx, "s22", scenario=scenario, trigger=trigger, during=during, probe=probe,
        new_owner_bond=new_owner_bond, **params)
    res.elapsed = time.time() - t_start["t"]
    return res


def takeover_ctx(**kw):
    bes = kw.pop("bes", [h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_COMMIT])
    return h.FakeCtx(bes_lines=bes)


def notice_script(extra=()):
    return [(0.05, h.NOTICE), (0.05, h.OWNER_LOSS), *extra]


class TakeoverTests(unittest.TestCase):
    def test_full_pass_waits_the_whole_interval_even_if_pairing_finishes_early(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        finished = {}

        def during():
            time.sleep(0.1)  # new owner pairs quickly; the observation must NOT end here
            finished["t"] = time.time()
            return "paired"

        res = run(ctx, probe, during=during)
        self.assertEqual(res.during_value, "paired")
        self.assertTrue(res.ok, [a for a in res.assertions if not a.ok])
        self.assertEqual(ctx.failed(), [])
        self.assertEqual(ctx.gaps, [])
        # full interval measured from the notice line (0.05 s after the trigger)
        self.assertGreaterEqual(res.elapsed, 0.05 + OBS - 0.02)
        self.assertLess(finished["t"] - probe.trigger_t, OBS)
        names = " ".join(ctx.ok_names())
        for needle in ("1 notice log line", "2 card", "3a", "3b", "3c", "4a", "4b", "5 new owner committed"):
            self.assertIn(needle, names)

    def test_connect_attempt_inside_interval_fails_3a_and_3c(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe(notice_script([(0.35, h.ATTEMPT)]), card_after=0.1)
        res = run(ctx, probe)
        failed = " ".join(ctx.failed())
        self.assertIn("3a no connect attempts", failed)
        self.assertIn("3c no reconnect log lines", failed)  # the attempt line also says "Reconnect attempt #"
        self.assertFalse(res.ok)

    def test_attempt_after_the_interval_is_not_counted(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe(notice_script([(OBS + 0.2, h.ATTEMPT)]), card_after=0.1)
        res = run(ctx, probe, during=lambda: time.sleep(OBS + 0.3))
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertTrue(res.ok)

    def test_stand_down_lines_themselves_are_not_reconnects(self):
        ctx = takeover_ctx()
        stand = "I/Bridge  (1): LIVE: Owner loss (entering_pairing_mode) — stopping reconnect, keeping saved glasses"
        probe = h.FakeProbe(notice_script([(0.2, stand)]), card_after=0.1)
        res = run(ctx, probe)
        self.assertEqual(ctx.failed(), [])

    def test_react_native_duplicates_are_ignored(self):
        ctx = takeover_ctx()
        dup = "I/ReactNativeJS(1): '[native:android]', '[I/Live] ATTEMPTING CONNECTION to device'"
        probe = h.FakeProbe(notice_script([(0.3, dup)]), card_after=0.1)
        run(ctx, probe)
        self.assertEqual(ctx.failed(), [])

    def test_card_later_than_10s_fails(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe(notice_script(), card_after=CARD + 0.2)
        run(ctx, probe)
        self.assertIn("R15 2 card 'In pairing mode' within 10 s", ctx.failed())

    def test_card_never_seen_fails(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe(notice_script(), card_after=None)
        run(ctx, probe)
        self.assertIn("R15 2 card 'In pairing mode' within 10 s", ctx.failed())

    def test_prompt_in_interval_fails_3b_and_is_dismissed(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe(notice_script(), card_after=0.1, prompt_at=0.3)
        run(ctx, probe)
        self.assertIn("R15 3b no sheet/prompt for 20 s", ctx.failed())
        self.assertEqual(probe.dismissed, ["配对请求"])

    def test_missing_notice_fails_and_still_runs_the_new_owner_action(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe([], card_after=0.1)
        called = []
        res = run(ctx, probe, during=lambda: called.append(1), notice_timeout=0.3)
        self.assertEqual(called, [1])
        self.assertIn("R15 1 notice log line on previous owner phone", ctx.failed())
        self.assertFalse(res.ok)

    def test_during_exception_is_recorded_not_raised(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe(notice_script(), card_after=0.1)

        def boom():
            raise RuntimeError("wda down")

        res = run(ctx, probe, during=boom)
        self.assertIn("R15 new-owner/during action completed", ctx.failed())
        self.assertIn("wda down", res.during_error)


class EvidenceRuleTests(unittest.TestCase):
    def test_missing_bes_commit_is_a_gap_not_a_pass(self):
        ctx = takeover_ctx(bes=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe)
        self.assertEqual(ctx.failed(), [])  # nothing contradicted
        self.assertEqual([g["gap"] for g in ctx.gaps], ["R15 5 new owner committed"])
        self.assertFalse(res.ok)

    def test_own1_plus_bond_proves_the_commit_when_the_ring_dropped_the_commit_line(self):
        ctx = takeover_ctx(bes=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_OWN1])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe, new_owner_bond=lambda: True)
        self.assertEqual(ctx.gaps, [])
        self.assertTrue(res.ok)
        self.assertEqual([a.source for a in res.assertions if a.name == "5 new owner committed"],
                         ["bes own=1 + new phone bond"])

    def test_own1_without_the_new_phones_bond_is_not_a_commit(self):
        ctx = takeover_ctx(bes=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_OWN1])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        run(ctx, probe, new_owner_bond=lambda: False)
        self.assertEqual([g["gap"] for g in ctx.gaps], ["R15 5 new owner committed"])

    def test_previous_owners_own1_before_entry_is_not_the_new_owner(self):
        # own=1/1 only from the PREVIOUS owner (before mode_enter_done); the new phone has a bond.
        ctx = takeover_ctx(bes=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        run(ctx, probe, new_owner_bond=lambda: True)
        self.assertEqual([g["gap"] for g in ctx.gaps], ["R15 5 new owner committed"])

    def test_phone_notice_backs_up_a_missing_bes_notice_trace(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe)
        a = next(a for a in res.assertions if a.name.startswith("4a"))
        self.assertTrue(a.ok)
        self.assertEqual(a.source, "phone received-notice line")

    def test_bes_notice_line_preferred_when_present(self):
        ctx = takeover_ctx(bes=[h.BES_PRE_OWNER, "105 | lxy pair: entering_pairing_mode sent", h.BES_ENTER,
                                h.BES_ENTER_DONE, h.BES_COMMIT])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe)
        a = next(a for a in res.assertions if a.name.startswith("4a"))
        self.assertEqual(a.source, "bes")

    def test_owner_removal_unproven_without_bes_record_is_a_gap(self):
        # The phone log and the card cannot prove BES erased ownership.
        ctx = takeover_ctx(bes=[h.BES_COMMIT])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        run(ctx, probe)
        self.assertIn("R15 4b previous owner removed (R4)", [g["gap"] for g in ctx.gaps])

    def test_owner_still_recorded_after_entry_fails(self):
        still = h.BES_ENTER_DONE.replace("own=0/0", "own=1/1")
        ctx = takeover_ctx(bes=[h.BES_PRE_OWNER, h.BES_ENTER, still, h.BES_COMMIT])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        run(ctx, probe)
        self.assertIn("R15 4b previous owner removed (R4)", ctx.failed())

    def test_bond_deletion_line_proves_removal(self):
        ctx = takeover_ctx(bes=["90 | lxy pair: clear_owner reason=bond_deleted", h.BES_COMMIT])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe)
        a = next(a for a in res.assertions if a.name.startswith("4b"))
        self.assertTrue(a.ok)
        self.assertEqual(a.source, "bes bond deletion")


class OtherScenarioTests(unittest.TestCase):
    def test_ownerless_closes_with_one_click_after_the_interval_and_checks_adv(self):
        ctx = h.FakeCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_CLOSE_REASON, h.BES_CLOSE])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        clicks = []

        def click():
            clicks.append(time.time() - probe.trigger_t)

        res = run(ctx, probe, scenario="ownerless", cancel_at_s=OBS + 0.1, inject_click=click,
                  adv=lambda: {"mentra": {"pairing": False}})
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertEqual(ctx.gaps, [])
        self.assertEqual(len(clicks), 1)
        self.assertGreaterEqual(clicks[0], 0.05 + OBS)  # after the full interval, never earlier
        self.assertTrue(res.ok)

    def test_ownerless_adv_still_pairing_fails(self):
        ctx = h.FakeCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_CLOSE_REASON, h.BES_CLOSE])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        run(ctx, probe, scenario="ownerless", cancel_at_s=OBS + 0.1, inject_click=lambda: None,
            adv=lambda: {"mentra": {"pairing": True}})
        self.assertIn("R15 6 adv pairing flag clear", ctx.failed())

    def test_ownerless_without_adv_is_a_gap(self):
        ctx = h.FakeCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_CLOSE_REASON, h.BES_CLOSE])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        run(ctx, probe, scenario="ownerless", cancel_at_s=OBS + 0.1, inject_click=lambda: None, adv=lambda: None)
        self.assertEqual([g["gap"] for g in ctx.gaps], ["R15 6 adv pairing flag clear"])

    def test_ownerless_does_not_require_a_new_owner_commit(self):
        ctx = h.FakeCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_CLOSE_REASON, h.BES_CLOSE])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        run(ctx, probe, scenario="ownerless", cancel_at_s=OBS + 0.1, inject_click=lambda: None,
            adv=lambda: {"mentra": {"pairing": False}})
        self.assertFalse([c for c in ctx.checks if "new owner" in c["check"]])

    def test_ownerless_close_none_leaves_a_gap(self):
        ctx = h.FakeCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe, scenario="ownerless", close_window="none")
        self.assertEqual([g["gap"] for g in ctx.gaps], ["R15 6 ownerless locked"])
        self.assertFalse(res.ok)

    def test_cancel_scenario_requires_single_click_once_exit_and_flag_clear(self):
        ctx = h.FakeCtx(
            bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_CANCEL, h.BES_CLOSE_REASON, h.BES_CLOSE],
            log_lines=["I/PairingAudio: hm_pairexit received reason=pclk"])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        clicks = []
        res = run(ctx, probe, scenario="cancel", cancel_at_s=0.4, inject_click=lambda: clicks.append(1),
                  adv=lambda: {"mentra": {"pairing": False}})
        self.assertEqual(clicks, [1])
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertEqual(ctx.gaps, [])
        self.assertTrue(res.ok)

    def test_cancel_scenario_double_pairexit_fails(self):
        ctx = h.FakeCtx(
            bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_CANCEL, h.BES_CLOSE],
            log_lines=["I/PairingAudio: hm_pairexit received reason=pclk"] * 2)
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        run(ctx, probe, scenario="cancel", cancel_at_s=0.4, inject_click=lambda: None,
            adv=lambda: {"mentra": {"pairing": False}})
        self.assertIn("R15 6 hm_pairexit exactly once", ctx.failed())

    def test_missed_notice_requires_rejection_owner_loss_card_and_quiet_after_it(self):
        reject_loss = "I/Bridge  (1): LIVE: Owner loss (gatt_auth_status_5) — stopping reconnect, keeping saved glasses"
        ctx = h.FakeCtx(bes_lines=[h.BES_REJECT])
        probe = h.FakeProbe([(0.1, h.ATTEMPT), (0.3, reject_loss)], card_after=0.4)
        res = run(ctx, probe, scenario="missed_notice_locked")
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertEqual(ctx.gaps, [])
        self.assertTrue(res.ok)
        # the attempt BEFORE the rejection (the one that got rejected) is outside the interval
        self.assertGreaterEqual(res.elapsed, 0.3 + OBS - 0.02)

    def test_missed_notice_new_attempt_after_rejection_fails(self):
        reject_loss = "I/Bridge  (1): LIVE: Owner loss (gatt_auth_status_5) — stopping reconnect, keeping saved glasses"
        ctx = h.FakeCtx(bes_lines=[h.BES_REJECT])
        probe = h.FakeProbe([(0.1, h.ATTEMPT), (0.3, reject_loss), (0.55, h.ATTEMPT)], card_after=0.4)
        run(ctx, probe, scenario="missed_notice_locked")
        self.assertIn("R15 3a no connect attempts for 20 s", ctx.failed())

    def test_missed_notice_without_bes_reject_is_a_gap_phone_log_alone_does_not_prove_it(self):
        reject_loss = "I/Bridge  (1): LIVE: Owner loss (gatt_auth_status_5) — stopping reconnect, keeping saved glasses"
        ctx = h.FakeCtx(bes_lines=[])
        probe = h.FakeProbe([(0.1, h.ATTEMPT), (0.3, reject_loss)], card_after=0.4)
        res = run(ctx, probe, scenario="missed_notice_locked")
        self.assertEqual(ctx.failed(), [])
        self.assertEqual([g["gap"] for g in ctx.gaps],
                         ["R15 4 glasses rejected the reconnect (HCI 0x05: ble_reject / encrypt_ltk drop)"])
        self.assertFalse(res.ok)

    def test_missed_notice_scenario_invalid_when_the_notice_arrives(self):
        ctx = h.FakeCtx(bes_lines=[h.BES_REJECT])
        probe = h.FakeProbe([(0.1, h.NOTICE), (0.3, h.OWNER_LOSS)], card_after=0.4)
        run(ctx, probe, scenario="missed_notice_locked")
        failed = ctx.failed()
        self.assertIn("R15 scenario valid: no entering_pairing_mode notice was received", failed)
        self.assertIn("R15 phone rejection-based owner loss (no notice)", failed)  # reason is entering_pairing_mode


class NoticeAndAfterCloseTests(unittest.TestCase):
    def test_notice_scenario_only_checks_the_universal_assertions(self):
        ctx = h.FakeCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe, scenario="notice")
        self.assertEqual(ctx.failed(), [])
        self.assertEqual(ctx.gaps, [])
        names = " ".join(c["check"] for c in ctx.checks)
        self.assertNotIn("new owner", names)
        self.assertNotIn("ownerless", names)
        self.assertTrue(res.ok)

    def test_observe_after_close_quiet_passes_and_late_attempt_fails(self):
        ctx = h.FakeCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_CLOSE_REASON, h.BES_CLOSE])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe, scenario="ownerless", cancel_at_s=OBS + 0.05, inject_click=lambda: None,
                  adv=lambda: {"mentra": {"pairing": False}})
        self.assertIsNotNone(res.t_cancel)
        owner_lost.observe_after_close(ctx, res, seconds=0.4, ui_poll_s=0.05, settle_s=0.0)
        self.assertEqual(ctx.failed(), [], ctx.failed())
        # a reclaim attempt 0.2 s after the close is caught
        ctx2 = h.FakeCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_CLOSE_REASON, h.BES_CLOSE])
        probe2 = h.FakeProbe(notice_script([(OBS + 0.3, h.ATTEMPT)]), card_after=0.1)
        res2 = run(ctx2, probe2, scenario="ownerless", cancel_at_s=OBS + 0.05, inject_click=lambda: None,
                   adv=lambda: {"mentra": {"pairing": False}})
        owner_lost.observe_after_close(ctx2, res2, seconds=0.5, ui_poll_s=0.05, settle_s=0.0)
        failed = " ".join(ctx2.failed())
        self.assertIn("7a no connect attempts", failed)
        self.assertIn("7b no reconnect log lines", failed)


class IntervalScanTests(unittest.TestCase):
    def test_boundaries_and_filters(self):
        t0 = 1000.0
        lines = [
            (t0 + 0.0, h.NOTICE),
            (t0 + 0.2, h.ATTEMPT),                # before settle: ignored
            (t0 + 1.0, h.ATTEMPT),                # inside
            (t0 + 5.0, "I/ReactNativeJS: ATTEMPTING CONNECTION"),  # RN duplicate
            (t0 + 5.5, "blocked ATTEMPTING CONNECTION"),
            (t0 + 20.0, h.ATTEMPT),               # exactly at the end: inside
            (t0 + 20.5, h.ATTEMPT),               # after
        ]
        out = owner_lost.phone_lines_in_interval(lines, t0, 20.0, settle_s=0.5)
        self.assertEqual([round(s - t0, 1) for s, _ in out], [1.0, 20.0])

    def test_ios_patterns(self):
        rx = owner_lost.IOS_CONNECT_RX
        self.assertTrue(rx.search("ImpossiBLE: sent 63 bytes (type=connect)"))
        self.assertTrue(rx.search("LIVE: Connecting to device: ABC"))
        self.assertFalse(rx.search("ImpossiBLE: sent 63 bytes (type=readRSSI)"))
        self.assertFalse(rx.search("ImpossiBLE: sent 245 bytes (type=write)"))
        self.assertTrue(owner_lost.IOS_RECONNECT_RX.search("LIVE: Scheduling reconnection attempt 1 in 2.0s"))
        self.assertFalse(owner_lost.IOS_RECONNECT_RX.search(
            "LIVE: Owner loss (entering_pairing_mode) — stopping reconnect, keeping saved glasses"))


if __name__ == "__main__":
    unittest.main()
