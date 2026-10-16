"""Snapshot 6 (re-baselined for OS-2055 v4): shared owner-removal proof, live-link precondition, adb-return handling,
the run_transition glue and the source rules."""

import re
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from tests import helpers as h
from tests.test_owner_removal import D4BFIX, st
import cases
import owner_lost
import pmx

class LegacyOwnerRemovalProofTests(unittest.TestCase):
    """The flag-off owner-removal proof is no longer asserted live (v4 keeps the owner at entry); readjudicate.py
    still re-judges the old runs with it, so the shared function stays covered."""

    def test_shared_function_gives_live_and_readjudicate_the_same_answer(self):
        pre, proof = owner_lost.owner_removal_proof(D4BFIX, None, newest=True)
        post = D4BFIX[2:]
        self.assertEqual(owner_lost.owner_removal_proof(D4BFIX, post), (pre, proof))
        # proof line must be in the post-press ring
        self.assertIsNone(owner_lost.owner_removal_proof(D4BFIX, D4BFIX[:2]))

    def test_readjudicate_uses_the_shared_function(self):
        src = Path(cases.__file__).with_name("readjudicate.py").read_text()
        self.assertIn("owner_removal_proof", src)


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
                                           L(2, "MAN: Device disconnected")], up, down))
        # the removed owner-loss line is no longer a link event at all
        self.assertTrue(cases.link_state([L(1, "Received pong response - connection healthy"),
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

    def test_run_transition_wires_the_precondition_before_the_gesture(self):
        order = []
        ctx = h.FakeCtx(bes_lines=[h.BES_XFER_ENTER, h.BES_MODE_ENTER, h.BES_ENTER_DONE, h.BES_CLOSE_TIMEOUT,
                                   h.BES_CLOSE_DUMP, h.BES_PAIREXIT_TIMEOUT], log_lines=[h.LOG_PAIREXIT_TIMEOUT])
        probe = h.FakeProbe([(0.05, h.PAIRING_MODE), (0.4, h.NORMAL), (0.5, h.LINK_UP)], popup_at=0.1)
        with mock.patch.object(cases, "await_live_link", lambda c, who, **k: order.append(f"link:{who}")):
            owner_lost.BES_POLL_S = 0.05
            res = cases.run_transition(
                ctx, "s22", scenario="timeout", probe=probe, adv=lambda: {"mentra": {"pairing": False}},
                notice_timeout=2, close_timeout=2, resume_timeout=2, reconnect_timeout=2, bes_timeout=0.1,
                settle_s=0.03, ui_poll_s=0.03, trigger=lambda: (order.append("press"), probe.fire()))
        self.assertEqual(order, ["link:s22", "press"])
        self.assertEqual(res.scenario, "timeout")

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


class SourceRuleTests(unittest.TestCase):
    def test_no_wait_glasses_boot_in_cases_and_ios_has_no_key_injection(self):
        text = Path(cases.__file__).read_text()
        self.assertNotIn("wait_glasses_boot", re.sub(r"pmx\.wait_glasses_boot\([^)]*\)", "", text))
        self.assertNotIn("inject", Path(cases.ios.__file__).read_text())

    def test_every_phone_previous_owner_case_goes_through_run_transition(self):
        text = Path(cases.__file__).read_text()
        self.assertNotIn("owner_lost.window_transition(ctx", text.replace(
            "return owner_lost.window_transition(ctx, previous_owner, **kw)", ""))
        for cid in ("O1_S22", "O1_IOS", "O2_S22", "O2_IOS", "O4_S22_MAC", "O4_S22_IOS", "O4_IOS_S22"):
            self.assertIn(cid, cases.CASES)

    def test_removed_protocol3_names_are_gone_from_the_harness_sources(self):
        here = Path(cases.__file__).parent
        for name in ("cases.py", "ios.py", "pmx.py"):
            text = (here / name).read_text()
            for dead in ("owner_lost_on_notice", "In pairing mode", "CONFIRM_REPLACE_RX", "android_pair_with_confirm",
                         "owner_lost_card", "run_owner_lost"):
                self.assertFalse(dead in text, f"{name}: {dead}")


if __name__ == "__main__":
    unittest.main()
