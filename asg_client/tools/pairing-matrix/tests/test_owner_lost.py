"""Unit tests for owner_lost.window_transition (OS-2055 v4: O1 timeout, O2 cancel, O4 takeover) with fakes.

Intervals are scaled down so each test runs about a second. No device, no adb, no simulator."""

import time
import unittest
from unittest import mock

from tests import helpers as h  # noqa: E402
import owner_lost  # noqa: E402

CARD = 0.25
FAST = dict(notice_timeout=2.0, close_timeout=2.0, resume_timeout=2.0, reconnect_timeout=2.0, rejection_timeout=2.0,
            card_s=CARD, post_quiet_s=0.4, bes_timeout=0.15, settle_s=0.03, ui_poll_s=0.03, cancel_at_s=0.3)

owner_lost.BES_POLL_S = 0.05
owner_lost.TIMEOUT_CLOSE_RANGE_S = (0.0, 30.0)  # the real window is 120 s; unit tests do not wait for it

ADV_TIMEOUT = lambda: {"mentra": {"pairing": False, "owner_changed": False}}  # noqa: E731
ADV_TAKEOVER = lambda: {"mentra": {"pairing": False, "owner_changed": True}}  # noqa: E731


def run(ctx, probe, scenario="timeout", during=None, new_owner_bond=None, **kw):
    t_start = {}

    def trigger():
        probe.fire()
        t_start["t"] = time.time()

    params = dict(FAST)
    params.update(kw)
    res = owner_lost.window_transition(
        ctx, "s22", scenario=scenario, trigger=trigger, during=during, probe=probe,
        new_owner_bond=new_owner_bond, **params)
    res.elapsed = time.time() - t_start["t"]
    return res


def entry_lines():
    return [h.BES_XFER_ENTER, h.BES_MODE_ENTER, h.BES_ENTER_DONE]


def timeout_ctx(**kw):
    bes = kw.pop("bes", entry_lines() + [h.BES_CLOSE_TIMEOUT, h.BES_CLOSE_DUMP, h.BES_PAIREXIT_TIMEOUT])
    log = kw.pop("log", [h.LOG_PAIREXIT_TIMEOUT])
    return h.FakeCtx(bes_lines=bes, log_lines=log)


def timeout_probe(extra=(), **kw):
    kw.setdefault("popup_at", 0.1)
    return h.FakeProbe([(0.05, h.PAIRING_MODE), (0.5, h.NORMAL), (0.6, h.LINK_UP), *extra], **kw)


def cancel_ctx(**kw):
    bes = kw.pop("bes", entry_lines() + [h.BES_TOGGLE, h.BES_CLOSE_TOGGLE, h.BES_CLOSE_DUMP, h.BES_PAIREXIT_CANCELLED])
    log = kw.pop("log", [h.LOG_PAIREXIT_CANCELLED])
    return h.FakeCtx(bes_lines=bes, log_lines=log)


def takeover_ctx(**kw):
    bes = kw.pop("bes", entry_lines() + [h.BES_FLOW_REPLACE, h.BES_COMMITTED, *h.BES_COMMIT_STEPS, h.BES_PAIREXIT_PAIRED])
    return h.FakeCtx(bes_lines=bes, log_lines=[h.LOG_PAIREXIT_PAIRED])


def takeover_probe(extra=(), **kw):
    kw.setdefault("popup_at", 0.1)
    kw.setdefault("pair_again_at", 0.35)
    return h.FakeProbe([(0.05, h.PAIRING_MODE), (0.3, h.REJECTED), *extra], **kw)


def failed_names(ctx):
    return " | ".join(ctx.failed())


class TimeoutTests(unittest.TestCase):
    """O1: the single window times out, A is never rejected and reconnects."""

    def test_full_pass(self):
        ctx = timeout_ctx()
        res = run(ctx, timeout_probe(), adv=ADV_TIMEOUT)
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertEqual(ctx.gaps, [])
        self.assertTrue(res.ok, [a for a in res.assertions if not a.ok])
        self.assertEqual(res.window_id, 7)
        self.assertEqual(res.popup_count, 1)
        names = " ".join(ctx.ok_names())
        for needle in ("1 SDK state pairing_mode", "2 popup", "3a", "3b", "3c", "3d", "4 no removed signal",
                       "5 SDK resumed to normal", "5 A reconnected", "5 never rejected", "6 window entry kept",
                       "7 BES closed the window", "7 closes near 120 s", "7 hm_pairexit reason=timeout",
                       "8 no bond change", "9 advertisement"):
            self.assertIn(needle, names)

    def test_two_popups_in_one_window_fail(self):
        ctx = timeout_ctx()
        run(ctx, timeout_probe(popup_again_at=0.3), adv=ADV_TIMEOUT)
        self.assertIn("2 popup", failed_names(ctx))

    def test_no_popup_fails(self):
        ctx = timeout_ctx()
        run(ctx, timeout_probe(popup_at=None), adv=ADV_TIMEOUT)
        self.assertIn("2 popup", failed_names(ctx))

    def test_connect_attempt_while_paused_fails_3a_and_3b(self):
        ctx = timeout_ctx()
        run(ctx, timeout_probe([(0.3, h.ATTEMPT)]), adv=ADV_TIMEOUT)
        failed = failed_names(ctx)
        self.assertIn("3a no connect attempts", failed)
        self.assertIn("3b no reconnect log lines", failed)

    def test_attempt_after_resume_is_not_counted(self):
        ctx = timeout_ctx()
        run(ctx, timeout_probe([(0.65, h.ATTEMPT)]), adv=ADV_TIMEOUT)
        self.assertEqual(ctx.failed(), [], ctx.failed())

    def test_pair_again_card_on_a_timeout_fails(self):
        ctx = timeout_ctx()
        run(ctx, timeout_probe(pair_again_at=0.2), adv=ADV_TIMEOUT)
        failed = failed_names(ctx)
        self.assertIn("3d no Pair Again while paused", failed)
        self.assertIn("5 never rejected", failed)

    def test_prompt_on_the_previous_owner_fails_and_is_dismissed(self):
        ctx = timeout_ctx()
        probe = timeout_probe(prompt_at=0.3)
        run(ctx, probe, adv=ADV_TIMEOUT)
        self.assertIn("3c no sheet/prompt", failed_names(ctx))
        self.assertEqual(probe.dismissed, ["配对请求"])

    def test_removed_protocol3_signal_fails(self):
        ctx = timeout_ctx()
        run(ctx, timeout_probe([(0.2, h.REMOVED_OWNER_LOSS)]), adv=ADV_TIMEOUT)
        self.assertIn("4 no removed signal", failed_names(ctx))

    def test_react_native_duplicates_are_ignored(self):
        ctx = timeout_ctx()
        dup = "I/ReactNativeJS(1): '[native:android]', '[I/Live] ATTEMPTING CONNECTION to device'"
        run(ctx, timeout_probe([(0.3, dup)]), adv=ADV_TIMEOUT)
        self.assertEqual(ctx.failed(), [], ctx.failed())

    def test_missing_pairing_mode_line_fails(self):
        ctx = timeout_ctx()
        probe = h.FakeProbe([(0.5, h.NORMAL), (0.6, h.LINK_UP)], popup_at=None)
        run(ctx, probe, adv=ADV_TIMEOUT, notice_timeout=0.3)
        self.assertIn("1 SDK state pairing_mode", failed_names(ctx))

    def test_no_resume_to_normal_fails(self):
        ctx = timeout_ctx()
        probe = h.FakeProbe([(0.05, h.PAIRING_MODE)], popup_at=0.1)
        res = run(ctx, probe, adv=ADV_TIMEOUT, resume_timeout=0.3)
        failed = failed_names(ctx)
        self.assertIn("5 SDK resumed to normal", failed)
        self.assertIn("5 A reconnected", failed)
        self.assertFalse(res.ok)

    def test_pairing_rejected_on_a_timeout_fails(self):
        ctx = timeout_ctx()
        probe = h.FakeProbe([(0.05, h.PAIRING_MODE), (0.4, h.REJECTED), (0.5, h.NORMAL), (0.6, h.LINK_UP)],
                            popup_at=0.1)
        run(ctx, probe, adv=ADV_TIMEOUT)
        self.assertIn("5 never rejected", failed_names(ctx))

    def test_owner_forgotten_at_entry_fails(self):
        ctx = timeout_ctx(bes=[h.BES_XFER_ENTER, h.BES_MODE_ENTER, h.BES_ENTER_DONE_FORGOT, h.BES_CLOSE_TIMEOUT,
                               h.BES_CLOSE_DUMP, h.BES_PAIREXIT_TIMEOUT])
        run(ctx, timeout_probe(), adv=ADV_TIMEOUT)
        self.assertIn("6 window entry kept the owner", failed_names(ctx))

    def test_missing_xfer_line_is_a_gap_not_a_pass(self):
        ctx = timeout_ctx(bes=[h.BES_MODE_ENTER, h.BES_CLOSE_TIMEOUT, h.BES_CLOSE_DUMP, h.BES_PAIREXIT_TIMEOUT])
        res = run(ctx, timeout_probe(), adv=ADV_TIMEOUT)
        self.assertEqual(ctx.failed(), [])
        self.assertEqual([g["gap"] for g in ctx.gaps],
                         ["V6 6 window entry kept the owner (xfer enter, owner retained, own != 0/0)"])
        self.assertFalse(res.ok)

    def test_close_outside_the_window_range_fails(self):
        ctx = timeout_ctx()
        with mock.patch.object(owner_lost, "TIMEOUT_CLOSE_RANGE_S", (50.0, 60.0)):
            run(ctx, timeout_probe(), adv=ADV_TIMEOUT)
        self.assertIn("7 closes near 120 s", failed_names(ctx))

    def test_missing_close_line_fails(self):
        ctx = timeout_ctx(bes=entry_lines())
        run(ctx, timeout_probe(), adv=ADV_TIMEOUT, close_timeout=0.2)
        self.assertIn("7 BES closed the window", failed_names(ctx))

    def test_double_pairexit_fails(self):
        ctx = timeout_ctx(log=[h.LOG_PAIREXIT_TIMEOUT] * 2)
        run(ctx, timeout_probe(), adv=ADV_TIMEOUT)
        self.assertIn("7 hm_pairexit reason=timeout exactly once", failed_names(ctx))

    def test_bond_change_fails(self):
        ctx = timeout_ctx(bes=entry_lines() + ["150 | lxy pair: clear_owner reason=x", h.BES_CLOSE_TIMEOUT,
                                               h.BES_CLOSE_DUMP, h.BES_PAIREXIT_TIMEOUT])
        run(ctx, timeout_probe(), adv=ADV_TIMEOUT)
        self.assertIn("8 no bond change", failed_names(ctx))

    def test_adv_still_pairing_or_owner_changed_fails(self):
        ctx = timeout_ctx()
        run(ctx, timeout_probe(), adv=lambda: {"mentra": {"pairing": True, "owner_changed": True}})
        failed = failed_names(ctx)
        self.assertIn("9 advertisement pairing flag clear", failed)
        self.assertIn("9 advertisement OWNER_CHANGED clear", failed)

    def test_adv_window_id_must_match_the_phone(self):
        ctx = timeout_ctx()
        run(ctx, timeout_probe(), adv=lambda: {"mentra": {"pairing": False, "owner_changed": False, "window_id": 9}})
        self.assertIn("9 advertisement window_id matches", failed_names(ctx))

    def test_missing_adv_is_a_gap(self):
        ctx = timeout_ctx()
        run(ctx, timeout_probe(), adv=lambda: None)
        self.assertEqual([g["gap"] for g in ctx.gaps], ["V6 9 advertisement pairing flag clear"])

    def test_during_exception_is_recorded_not_raised(self):
        ctx = timeout_ctx()

        def boom():
            raise RuntimeError("wda down")

        res = run(ctx, timeout_probe(), during=boom, adv=ADV_TIMEOUT)
        self.assertIn("new-owner/during action completed", failed_names(ctx))
        self.assertIn("wda down", res.during_error)

    def test_unknown_scenario_is_rejected(self):
        with self.assertRaises(ValueError):
            owner_lost.window_transition(h.FakeCtx(), "s22", scenario="ownerless", trigger=lambda: None,
                                         probe=h.FakeProbe([]))


class CancelTests(unittest.TestCase):
    """O2: a triple press toggles the window closed. A single press never cancels."""

    def test_full_pass_with_one_cancel_gesture(self):
        ctx = cancel_ctx()
        gestures = []
        res = run(ctx, timeout_probe(), scenario="cancel", inject_cancel=lambda: gestures.append(time.time()),
                  adv=ADV_TIMEOUT)
        self.assertEqual(gestures.__len__(), 1)
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertEqual(ctx.gaps, [])
        self.assertTrue(res.ok)
        self.assertGreaterEqual(gestures[0] - probe_trigger(res), 0.05 + 0.3 - 0.03)
        names = " ".join(ctx.ok_names())
        self.assertIn("7 triple press toggled the window", names)
        self.assertIn("7 hm_pairexit reason=cancelled exactly once", names)

    def test_default_cancel_gesture_is_one_triple_press(self):
        ctx = cancel_ctx()
        with mock.patch("pmx.inject") as inject:
            run(ctx, timeout_probe(), scenario="cancel", adv=ADV_TIMEOUT)
        inject.assert_called_once_with("triple", 50)

    def test_single_click_cancel_is_not_accepted(self):
        # The removed protocol-3 evidence (`cancel by single click`) must not satisfy the triple-press rows.
        old = "400 | lxy pair: cancel by single click"
        ctx = cancel_ctx(bes=entry_lines() + [old, h.BES_CLOSE_DUMP, h.BES_PAIREXIT_CANCELLED])
        run(ctx, timeout_probe(), scenario="cancel", inject_cancel=lambda: None, adv=ADV_TIMEOUT, bes_timeout=0.2)
        failed = failed_names(ctx)
        self.assertIn("7 BES closed the window", failed)
        self.assertIn("7 triple press toggled the window", failed)

    def test_wrong_exit_reason_fails(self):
        ctx = cancel_ctx(bes=entry_lines() + [h.BES_TOGGLE, h.BES_CLOSE_TOGGLE, h.BES_CLOSE_DUMP],
                         log=[h.LOG_PAIREXIT_TIMEOUT, h.LOG_PAIREXIT_TIMEOUT])
        run(ctx, timeout_probe(), scenario="cancel", inject_cancel=lambda: None, adv=ADV_TIMEOUT)
        self.assertIn("7 hm_pairexit reason=cancelled exactly once", failed_names(ctx))

    def test_adv_still_pairing_after_cancel_fails(self):
        ctx = cancel_ctx()
        run(ctx, timeout_probe(), scenario="cancel", inject_cancel=lambda: None,
            adv=lambda: {"mentra": {"pairing": True, "owner_changed": False}})
        self.assertIn("9 advertisement pairing flag clear", failed_names(ctx))


def probe_trigger(res):
    return res.probe.trigger_t


class TakeoverTests(unittest.TestCase):
    """O4: B commits (V2 wipe order), A reaches pairing_rejected and shows only Pair Again."""

    def test_full_pass(self):
        ctx = takeover_ctx()
        res = run(ctx, takeover_probe(), scenario="takeover", during=lambda: "paired", adv=ADV_TAKEOVER)
        self.assertEqual(res.during_value, "paired")
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertEqual(ctx.gaps, [])
        self.assertTrue(res.ok, [a for a in res.assertions if not a.ok])
        names = " ".join(ctx.ok_names())
        for needle in ("5 A's SDK reached pairing_rejected", "5 Pair Again card within 10 s", "5 stood down",
                       "5 A never shows connected again", "7 new owner committed", "8 commit steps 1/3, 2/3, 3/3",
                       "8 pairflow commit replace_owner", "8 closed as paired", "9 advertisement OWNER_CHANGED set"):
            self.assertIn(needle, names)

    def test_commit_steps_out_of_order_fail(self):
        steps = [h.BES_COMMIT_STEPS[1], h.BES_COMMIT_STEPS[0], h.BES_COMMIT_STEPS[2]]
        ctx = takeover_ctx(bes=entry_lines() + [h.BES_FLOW_REPLACE, h.BES_COMMITTED, *steps, h.BES_PAIREXIT_PAIRED])
        run(ctx, takeover_probe(), scenario="takeover", adv=ADV_TAKEOVER)
        self.assertIn("8 commit steps 1/3, 2/3, 3/3", failed_names(ctx))

    def test_no_pair_again_card_fails(self):
        ctx = takeover_ctx()
        run(ctx, takeover_probe(pair_again_at=None), scenario="takeover", adv=ADV_TAKEOVER)
        self.assertIn("5 Pair Again card within 10 s", failed_names(ctx))

    def test_pair_again_later_than_the_budget_fails(self):
        ctx = takeover_ctx()
        run(ctx, takeover_probe(pair_again_at=0.3 + CARD + 0.2), scenario="takeover", adv=ADV_TAKEOVER)
        self.assertIn("5 Pair Again card within 10 s", failed_names(ctx))

    def test_pair_again_before_the_rejection_fails(self):
        ctx = takeover_ctx()
        run(ctx, takeover_probe(pair_again_at=0.15), scenario="takeover", adv=ADV_TAKEOVER)
        self.assertIn("3d no Pair Again while paused", failed_names(ctx))

    def test_never_rejected_fails(self):
        ctx = takeover_ctx()
        probe = h.FakeProbe([(0.05, h.PAIRING_MODE), (0.3, h.NORMAL)], popup_at=0.1, pair_again_at=0.35)
        run(ctx, probe, scenario="takeover", adv=ADV_TAKEOVER, rejection_timeout=0.4)
        self.assertIn("5 A's SDK reached pairing_rejected", failed_names(ctx))

    def test_connect_attempt_after_the_rejection_fails(self):
        ctx = takeover_ctx()
        run(ctx, takeover_probe([(0.5, h.ATTEMPT)]), scenario="takeover", adv=ADV_TAKEOVER)
        self.assertIn("5 stood down", failed_names(ctx))

    def test_connected_again_after_the_rejection_fails(self):
        ctx = takeover_ctx()
        run(ctx, takeover_probe([(0.5, h.LINK_UP)]), scenario="takeover", adv=ADV_TAKEOVER)
        self.assertIn("5 A never shows connected again", failed_names(ctx))

    def test_adv_without_owner_changed_fails(self):
        ctx = takeover_ctx()
        run(ctx, takeover_probe(), scenario="takeover", adv=ADV_TIMEOUT)
        self.assertIn("9 advertisement OWNER_CHANGED set", failed_names(ctx))

    def test_missing_commit_evidence_fails(self):
        ctx = takeover_ctx(bes=entry_lines())
        run(ctx, takeover_probe(), scenario="takeover", adv=ADV_TAKEOVER)
        self.assertIn("7 new owner committed", failed_names(ctx))

    def test_own1_plus_bond_proves_the_commit_when_the_ring_dropped_the_commit_line(self):
        ctx = takeover_ctx(bes=entry_lines() + [h.BES_OWN1_B, h.BES_FLOW_REPLACE, *h.BES_COMMIT_STEPS,
                                                h.BES_PAIREXIT_PAIRED])
        res = run(ctx, takeover_probe(), scenario="takeover", adv=ADV_TAKEOVER, new_owner_bond=lambda: True)
        self.assertEqual(ctx.failed(), [], ctx.failed())
        a = next(a for a in res.assertions if a.name.startswith("7 new owner committed"))
        self.assertEqual(a.source, "bes own=1 + new phone bond")

    def test_own1_without_the_new_phones_bond_is_not_a_commit(self):
        ctx = takeover_ctx(bes=entry_lines() + [h.BES_OWN1_B])
        run(ctx, takeover_probe(), scenario="takeover", adv=ADV_TAKEOVER, new_owner_bond=lambda: False)
        self.assertIn("7 new owner committed", failed_names(ctx))

    def test_previous_owners_own1_before_entry_is_not_the_new_owner(self):
        # own=1/1 only before mode_enter_done is the PREVIOUS owner's record, never B's commit.
        before = "40 | lxy pair: pwr_press st=OWNER_ONLY exp=1 own=1/1 clicks=3/3 fired=1 ind=0 lock=0 generation=1"
        ctx = takeover_ctx(bes=[before] + entry_lines())
        run(ctx, takeover_probe(), scenario="takeover", adv=ADV_TAKEOVER, new_owner_bond=lambda: True)
        self.assertIn("7 new owner committed", failed_names(ctx))

    def test_during_exception_is_recorded_not_raised(self):
        ctx = takeover_ctx()

        def boom():
            raise RuntimeError("mac sheet stuck")

        res = run(ctx, takeover_probe(), scenario="takeover", during=boom, adv=ADV_TAKEOVER)
        self.assertIn("new-owner/during action completed", failed_names(ctx))
        self.assertIn("mac sheet stuck", res.during_error)

    def test_observe_quiet_passes_and_a_late_attempt_fails(self):
        ctx = takeover_ctx()
        res = run(ctx, takeover_probe(), scenario="takeover", adv=ADV_TAKEOVER)
        owner_lost.observe_quiet(ctx, res, seconds=0.4, ui_poll_s=0.05, settle_s=0.0)
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertIn("10d Pair Again card still shown", " ".join(ctx.ok_names()))
        ctx2 = takeover_ctx()
        res2 = run(ctx2, takeover_probe([(0.55, h.ATTEMPT)]), scenario="takeover", adv=ADV_TAKEOVER, post_quiet_s=0.05)
        owner_lost.observe_quiet(ctx2, res2, seconds=0.6, ui_poll_s=0.05, settle_s=0.0)
        failed = failed_names(ctx2)
        self.assertIn("10a no connect attempts", failed)
        self.assertIn("10b no reconnect log lines", failed)


class IntervalScanTests(unittest.TestCase):
    def test_boundaries_and_filters(self):
        t0 = 1000.0
        lines = [
            (t0 + 0.0, h.PAIRING_MODE),
            (t0 + 0.2, h.ATTEMPT),                # before settle: ignored
            (t0 + 1.0, h.ATTEMPT),                # inside
            (t0 + 5.0, "I/ReactNativeJS: ATTEMPTING CONNECTION"),  # RN duplicate
            (t0 + 5.5, "blocked ATTEMPTING CONNECTION"),
            (t0 + 20.0, h.ATTEMPT),               # exactly at the end: inside
            (t0 + 20.5, h.ATTEMPT),               # after
        ]
        out = owner_lost.phone_lines_in_interval(lines, t0, t0 + 20.0, settle_s=0.5)
        self.assertEqual([round(s - t0, 1) for s, _ in out], [1.0, 20.0])

    def test_state_lines_are_not_activity(self):
        t0 = 1000.0
        lines = [(t0 + 1.0, h.PAIRING_MODE), (t0 + 2.0, h.NORMAL), (t0 + 3.0, h.REJECTED)]
        self.assertEqual(owner_lost.phone_lines_in_interval(lines, t0, t0 + 10.0), [])

    def test_state_regexes(self):
        m = owner_lost.PAIRING_MODE_RX.search(h.pairing_mode_line(12))
        self.assertEqual(m.group("window"), "12")
        self.assertTrue(owner_lost.NORMAL_RX.search(h.NORMAL))
        self.assertTrue(owner_lost.REJECTED_RX.search(h.REJECTED))
        self.assertFalse(owner_lost.NORMAL_RX.search(h.REJECTED))

    def test_removed_signal_regex(self):
        rx = owner_lost.REMOVED_SIGNAL_RX
        for line in (h.REMOVED_OWNER_LOSS, "owner_replaced", "owner lost, no reconnect", "confirm_replace_owner_result",
                     "awaiting_confirm: true", "retained_owner_link", "owner_reclaim sent"):
            self.assertTrue(rx.search(line), line)
        self.assertFalse(rx.search(h.PAIRING_MODE))

    def test_ios_patterns(self):
        rx = owner_lost.IOS_CONNECT_RX
        self.assertTrue(rx.search("ImpossiBLE: sent 63 bytes (type=connect)"))
        self.assertTrue(rx.search("LIVE: Connecting to device: ABC"))
        self.assertFalse(rx.search("ImpossiBLE: sent 63 bytes (type=readRSSI)"))
        self.assertFalse(rx.search("ImpossiBLE: sent 245 bytes (type=write)"))
        self.assertTrue(owner_lost.IOS_RECONNECT_RX.search("LIVE: Scheduling reconnection attempt 1 in 2.0s"))
        self.assertFalse(owner_lost.IOS_RECONNECT_RX.search(h.REMOVED_OWNER_LOSS))


if __name__ == "__main__":
    unittest.main()
