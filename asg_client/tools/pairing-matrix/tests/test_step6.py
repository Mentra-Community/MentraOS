"""Snapshot 6: live-path 4b rule, live-link precondition, open vs locked missed notice, adb-return handling."""

import re
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from tests import helpers as h
from tests.test_owner_lost import notice_script, run
from tests.test_owner_removal import D4BFIX, st
import cases
import owner_lost
import pmx

REJ_LOSS = "I/Bridge  (1): LIVE: Owner loss (bond_removed_by_glasses) — stopping reconnect, keeping saved glasses"


class LivePath4bTests(unittest.TestCase):
    """Pre-entry own>=1 line sits BEFORE the gesture mark (the own_probe / R_S22 result); the ring after the presses
    has only the PAIRING lines."""

    def go(self, before, after):
        ctx = h.FakeCtx(bes_lines=list(before) + list(after))
        ctx.g.mark_at = len(before)
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe, scenario="notice")
        a = next(a for a in res.assertions if a.name.startswith("4b"))
        return ctx, a

    PRE = [st("click_window_end", "OWNER_ONLY", "1/1", 3, 1623991)]

    def test_pre_entry_owner_line_from_before_the_presses_is_used(self):
        ctx, a = self.go(self.PRE, [st("ble_connect", "PAIRING", "0/0", 4, 370)])
        self.assertTrue(a.ok, a.detail)
        self.assertEqual(a.source, "bes owner record (generation advanced)")
        self.assertEqual(ctx.gaps, [])

    def test_same_generation_after_the_presses_is_still_a_gap(self):
        ctx, a = self.go(self.PRE, [st("ble_connect", "PAIRING", "0/0", 3)])
        self.assertTrue(a.gap)

    def test_no_pre_entry_owner_anywhere_is_a_gap(self):
        ctx, a = self.go([st("pwr_press", "OWNER_ONLY", "0/0", 3)], [st("ble_connect", "PAIRING", "0/0", 4)])
        self.assertTrue(a.gap)

    def test_a_transition_from_an_earlier_window_before_the_presses_never_counts(self):
        before = [st("session_up", "OWNER_ONLY", "1/1", 2), st("ble_connect", "PAIRING", "0/0", 3),   # setup event
                  st("session_up", "OWNER_ONLY", "0/0", 3)]                                               # owner gone, no own>=1 after
        ctx, a = self.go(before, [st("pwr_press", "OWNER_ONLY", "0/0", 3)])
        self.assertTrue(a.gap)

    def test_lower_generation_after_the_presses_is_a_gap(self):
        ctx, a = self.go([st("pwr_press", "OWNER_ONLY", "1/1", 5)], [st("ble_connect", "PAIRING", "0/0", 4)])
        self.assertTrue(a.gap)

    def test_shared_function_gives_live_and_readjudicate_the_same_answer(self):
        pre, proof = owner_lost.owner_removal_proof(D4BFIX, None, newest=True)
        post = D4BFIX[2:]
        self.assertEqual(owner_lost.owner_removal_proof(D4BFIX, post), (pre, proof))
        # proof line must be in the post-press ring
        self.assertIsNone(owner_lost.owner_removal_proof(D4BFIX, D4BFIX[:2]))

    def test_readjudicate_uses_the_shared_function(self):
        src = Path(cases.__file__).with_name("readjudicate.py").read_text()
        self.assertIn("owner_removal_proof", src)


class MissedNoticeVariants(unittest.TestCase):
    def go(self, bes, scenario):
        ctx = h.FakeCtx(bes_lines=bes)
        probe = h.FakeProbe([(0.1, h.ATTEMPT), (0.3, REJ_LOSS)], card_after=0.4)
        res = run(ctx, probe, scenario=scenario)
        return ctx, res

    def test_open_window_variant_needs_no_0x05_only_own_0_0_staying(self):
        ctx, res = self.go([st("ble_connect", "PAIRING", "0/0", 4)], "missed_notice")
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertEqual(ctx.gaps, [])
        self.assertTrue(res.ok)

    def test_open_window_variant_fails_when_the_glasses_admit_the_phone(self):
        ctx, _ = self.go([st("ble_connect", "PAIRING", "0/0", 4), st("session_up", "OWNER_ONLY", "1/1", 4)],
                         "missed_notice")
        self.assertIn("R15 4 glasses did not admit the returning phone as owner (own=0/0 stays)", ctx.failed())

    def test_open_window_variant_without_any_bes_record_is_a_gap(self):
        ctx, _ = self.go([], "missed_notice")
        self.assertEqual(len(ctx.gaps), 1)

    def test_locked_variant_requires_the_0x05_evidence_lines(self):
        for line in ("300 | lxy pair: ble_reject auth=2 st=OWNER_ONLY", "301 | lxy pair: ble_reject auth=0 st=OWNER_ONLY",
                     "302 | lxy pair: encrypt_ltk drop"):
            ctx, res = self.go([line], "missed_notice_locked")
            self.assertEqual(ctx.gaps, [], line)
            self.assertEqual(ctx.failed(), [], line)
        ctx, _ = self.go([st("ble_connect", "PAIRING", "0/0", 4)], "missed_notice_locked")
        self.assertEqual(len(ctx.gaps), 1)  # own=0/0 alone is not a reject

    def test_live_link_is_not_required_before_a_missed_notice_trigger(self):
        called = []
        ctx = h.FakeCtx(bes_lines=[h.BES_REJECT])
        probe = h.FakeProbe([(0.1, h.ATTEMPT), (0.3, REJ_LOSS)], card_after=0.4)
        run(ctx, probe, scenario="missed_notice_locked", live_link=lambda: called.append(1))
        self.assertEqual(called, [])


class LiveLinkTests(unittest.TestCase):
    class Clock:
        def __init__(self):
            self.now = 100.0

        def time(self):
            return self.now

        def sleep(self, s):
            self.now += s

    def ctx(self, lines):
        c = h.FakeCtx()
        c.p = types.SimpleNamespace(since=lambda m: lines())
        c.i = c.p
        return c

    def test_link_state_last_event_wins_and_ignores_rn_duplicates(self):
        up, down = cases.LINK_UP_RX["s22"], cases.LINK_DOWN_RX["s22"]
        L = lambda t, x: (t, x)
        self.assertIsNone(cases.link_state([], up, down))
        self.assertTrue(cases.link_state([L(1, "LIVE: Received pong response - connection healthy")], up, down))
        self.assertFalse(cases.link_state([L(1, "BLE reconnection fully ready (Core TX/RX verified"),
                                           L(2, "LIVE: Disconnecting from Mentra Live glasses")], up, down))
        self.assertTrue(cases.link_state([L(1, "LIVE: Disconnected from GATT server"),
                                          L(2, "LIVE: 🎉 Received glasses_ready message - SOC is booted")], up, down))
        self.assertFalse(cases.link_state([L(1, "Received pong response - connection healthy"),
                                           L(2, "LIVE: Owner loss (gatt_auth_status_5) — stopping reconnect")], up, down))
        self.assertIsNone(cases.link_state([L(1, "I/ReactNativeJS: Received pong response - connection healthy")], up, down))
        self.assertIsNone(cases.link_state([L(1, "LIVE: Ignoring stale glasses_ready during pairing yield")], up, down))

    def test_live_when_a_pong_arrives_within_the_bound(self):
        clock = self.Clock()
        lines = []
        # a heartbeat pong shows up 30 s in
        def src():
            if clock.time() >= 130:
                lines.append((130, "LIVE: Received pong response - connection healthy"))
            return list(lines)
        self.assertEqual(cases.await_live_link(self.ctx(src), "s22", timeout=60, clock=clock), "live")
        self.assertLessEqual(clock.time() - 100, 40)

    def test_blocked_after_60s_with_no_link_event(self):
        clock = self.Clock()
        with self.assertRaisesRegex(cases.PreviousOwnerLinkDown, "no live link.*no link event"):
            cases.await_live_link(self.ctx(lambda: []), "ios", timeout=60, clock=clock)
        self.assertGreaterEqual(clock.time() - 100, 60)

    def test_blocked_when_the_last_event_is_a_disconnect_and_nothing_tries_to_press(self):
        clock = self.Clock()
        with mock.patch.object(cases, "pmx") as pm:
            with self.assertRaisesRegex(cases.PreviousOwnerLinkDown, "disconnect"):
                cases.await_live_link(self.ctx(lambda: [(1, "LIVE: Disconnected from GATT server")]), "s22",
                                      timeout=10, clock=clock)
            pm.inject.assert_not_called()

    def test_run_owner_lost_wires_the_precondition_before_the_gesture(self):
        order = []
        ctx = h.FakeCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_COMMIT])
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        with mock.patch.object(cases, "await_live_link", lambda c, who, **k: order.append(f"link:{who}")):
            owner_lost.BES_POLL_S = 0.05
            cases.run_owner_lost(ctx, "s22", scenario="notice", probe=probe, observe_s=0.3, card_s=0.2,
                                 notice_timeout=2, bes_timeout=0.1, settle_s=0.03, ui_poll_s=0.03,
                                 trigger=lambda: (order.append("press"), probe.fire()))
        self.assertEqual(order, ["link:s22", "press"])

    def test_missing_link_blocks_the_case_and_stops_the_run(self):
        ctx = h.FakeCtx()
        ctx.blocked = ""
        self.assertIn("BLOCKED", "BLOCKED")  # status mapping is covered by Ctx.finish below
        c = cases.Ctx.__new__(cases.Ctx)
        c.checks, c.gaps, c.bench, c.notes = [], [], [], []
        c.blocked, c.stop_run_reason, c.untestable = "precondition: previous owner has no live link (s22)", "", ""
        c.invalid, c.phases, c._phase_open = "", [], {}
        c.dir = Path(__import__("tempfile").mkdtemp())
        c.unit3 = {}
        c.g = types.SimpleNamespace(stop=lambda: None, mark=lambda: 0, lines=[], since=lambda m: [])
        c.p = c.i = c.g
        with mock.patch.object(cases.time, "sleep"), mock.patch.object(cases.pmx, "bes_lines", lambda *a, **k: []):
            res = c.finish()
        self.assertEqual(res["status"], "BLOCKED")
        self.assertIn("no live link", res["blocked_reason"])


class WaitUnit3ReturnTests(unittest.TestCase):
    HEADER = "transport usb role serial cid\n"
    ROW = "5 usb:1-1 unit3 0123456789ABCDEF 1501003458364b4d4203b71dcc5eb7b3\n"

    def clock(self):
        return LiveLinkTests.Clock()

    def run_fn(self, outputs):
        it = iter(outputs)

        def run(argv, **kw):
            return types.SimpleNamespace(stdout=next(it), stderr="", returncode=0)
        return run

    def test_returns_elapsed_when_the_row_appears_and_polls_every_15s(self):
        clk = self.clock()
        out = [self.HEADER] * 3 + [self.HEADER + self.ROW]
        el = pmx.wait_unit3_return(1200, 15, run=self.run_fn(out), clock=clk)
        self.assertEqual(el, 45.0)

    def test_gives_up_after_the_timeout(self):
        clk = self.clock()
        el = pmx.wait_unit3_return(60, 15, run=self.run_fn([self.HEADER] * 20), clock=clk)
        self.assertIsNone(el)
        self.assertGreaterEqual(clk.time() - 100, 60)

    def test_two_unit3_rows_raise(self):
        with self.assertRaises(pmx.Unit3GuardError):
            pmx.wait_unit3_return(60, 15, run=self.run_fn([self.HEADER + self.ROW + self.ROW]), clock=self.clock())

    def test_never_uses_glasses_adb(self):
        seen = []

        def run(argv, **kw):
            seen.append(argv)
            return types.SimpleNamespace(stdout=self.HEADER + self.ROW, stderr="", returncode=0)

        pmx.wait_unit3_return(10, 1, run=run, clock=self.clock())
        self.assertEqual(seen, [[str(pmx.LAB_UNITS)]])


class GlueBase(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.tmp = tempfile.mkdtemp()
        self.pmx = mock.MagicMock(unsafe=True)
        self.pmx.ui_find.return_value = None
        self.pmx.wait_unit3_return.return_value = None  # adb never comes back in this scenario
        self.calls = []
        self.pmx.gsh.side_effect = lambda *a, **k: self.calls.append(("gsh", a))
        self.pmx.assert_unit3.side_effect = lambda *a, **k: self.calls.append(("assert_unit3",))
        patches = [
            mock.patch.object(cases, "pmx", self.pmx),
            mock.patch.object(cases, "time", types.SimpleNamespace(sleep=lambda *_: None, time=time.time,
                                                                   strftime=time.strftime)),
            mock.patch.object(cases, "s22_holds_bond", lambda: True),
            mock.patch.object(cases, "await_live_link", lambda ctx, who, **k: "live"),
            mock.patch.object(cases, "wait_owner_link", lambda ctx, mark, timeout=60: (1, "ready")),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def ctx(self):
        from tests.test_case_glue import GlueCtx
        c = GlueCtx(self.tmp, bes_lines=[])
        c.p = types.SimpleNamespace(mark=lambda: 0, since=lambda m: [])
        c.adv = lambda seconds=5.0: {"mentra": {"pairing": False}}
        return c


class E3GlueTests(GlueBase):
    def test_product_verdict_without_adb_and_run_stops_when_adb_never_returns(self):
        c = self.ctx()
        cases.CASES["E3"](c)
        self.assertEqual(c.failed(), [], c.failed())           # product verdict unaffected by the missing adb
        self.assertEqual([x["bench"] for x in c.bench], ["usb return within cap"])
        self.assertIn("4 min", c.blocked)
        self.assertFalse(c.bench[0]["ok"])
        self.assertTrue(c.stop_run_reason)
        # no glasses adb after the reboot request except the guard before it
        reboot_i = next(i for i, x in enumerate(self.calls) if x[0] == "gsh" and x[1][0] == "reboot")
        self.assertEqual(self.calls[reboot_i - 1], ("assert_unit3",))
        self.assertEqual([x for x in self.calls[reboot_i + 1:] if x[0] == "gsh"], [])
        self.pmx.LogTap.assert_not_called()

    def test_adb_back_reasserts_unit3_then_records_the_measured_time(self):
        self.pmx.wait_unit3_return.return_value = 600.0
        self.pmx.wait_glasses_boot.return_value = True
        c = self.ctx()
        self.pmx.LogTap.return_value.start.return_value = c.g
        cases.CASES["E3"](c)
        self.assertEqual(c.failed(), [], c.failed())
        self.assertEqual([x["bench"] for x in c.bench][:1], ["adb returned and exactly one unit3"])
        self.assertTrue(c.bench[0]["ok"])
        self.assertEqual(c.stop_run_reason, "")
        self.assertIn(("assert_unit3",), self.calls)


class BtoffGlueTests(GlueBase):
    def test_locked_variant_presses_once_clicks_once_and_runs_the_locked_scenario(self):
        seen = {}

        def fake(ctx, prev, *, scenario, trigger, **kw):
            seen["scenario"] = scenario
            trigger()
            return owner_lost.OwnerLostResult(scenario=scenario, previous_owner=prev)

        c = self.ctx()
        c.g.bes_lines.extend([st("pwr_press", "OWNER_ONLY", "1/1", 3), st("mode_enter_done", "PAIRING", "0/0", 4),
                              st("click_window_end", "PAIRING", "0/0", 4)])
        with mock.patch.object(cases, "r_s22", lambda ctx: True), \
                mock.patch.object(cases.owner_lost, "owner_lost_on_notice", fake):
            cases.CASES["BTOFF_REJOIN_LOCKED"](c)
        self.assertEqual(seen["scenario"], "missed_notice_locked")
        injects = [call.args[0] for call in self.pmx.inject.call_args_list]
        self.assertEqual(len(injects), 2)  # the one 3-press gesture + one single click
        self.assertEqual(injects[1], "C")
        self.assertEqual([call.args[0] for call in self.pmx.phone_bt.call_args_list], [False, True])
        self.assertEqual(c.failed(), [], c.failed())


class SourceRuleTests(unittest.TestCase):
    def test_no_wait_glasses_boot_in_cases_and_ios_has_no_key_injection(self):
        text = Path(cases.__file__).read_text()
        self.assertNotIn("wait_glasses_boot", re.sub(r"pmx\.wait_glasses_boot\([^)]*\)", "", text))
        self.assertNotIn("inject", Path(cases.ios.__file__).read_text())

    def test_every_phone_previous_owner_case_goes_through_run_owner_lost(self):
        text = Path(cases.__file__).read_text()
        self.assertNotIn("owner_lost.owner_lost_on_notice(ctx", text.replace(
            "return owner_lost.owner_lost_on_notice(ctx, previous_owner, **kw)", ""))
        self.assertIn("BTOFF_REJOIN_LOCKED", cases.CASES)


if __name__ == "__main__":
    unittest.main()
