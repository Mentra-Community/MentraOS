"""Run the rewritten cases against fakes: catches glue errors (wrong unpacking, missing helpers, bad arguments)
without touching a device. owner_lost_on_notice itself is replaced by a stub that runs trigger()/during()."""

import time
import types
import unittest
from pathlib import Path
from unittest import mock

from tests import helpers as h
import cases
import owner_lost


class GlueCtx(h.FakeCtx):
    def __init__(self, tmp, bes_lines=None):
        super().__init__(bes_lines=bes_lines if bes_lines is not None
                         else [h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_COMMIT])
        self.dir = Path(tmp)
        self.p = types.SimpleNamespace(mark=lambda: 0, since=lambda m: [], wait_for=lambda *a, **k: None)
        self.i = types.SimpleNamespace(mark=lambda: 0, since=lambda m: [], grep=lambda *a, **k: ["pairing_info"],
                                       wait_for=lambda *a, **k: (time.time(), "Received glasses_ready"))
        self.untestable = ""
        self.g.since = lambda m: [(time.time(), "I/PairingAudio: hm_pairexit received reason=paired")]

    def bes_wait(self, pattern, timeout, mark=None):
        return (time.time(), "200 | lxy pair: owner committed from ble bond")

    def log_wait(self, tap, pattern, timeout, mark=0):
        return (time.time(), "hit")

    def ios_wait(self, pattern, timeout, mark=0):
        return (time.time(), "hit")

    def shot(self, name):
        return self.dir / f"{name}.png"

    ishot = shot

    def adv(self, seconds=5.0):
        return {"mentra": {"pairing": False}}

    def not_testable(self, why):
        self.untestable = why


def fake_owner_lost(ctx, previous_owner, *, scenario, trigger, during=None, **kw):
    trigger()
    res = owner_lost.OwnerLostResult(scenario=scenario, previous_owner=previous_owner)
    res.t0 = time.time()
    res.during_value = during() if during else None
    return res


class GlueTests(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.tmp = tempfile.mkdtemp()
        self.ctx = GlueCtx(self.tmp)
        pmx_mock = mock.MagicMock(unsafe=True)
        pmx_mock.ui_find.return_value = None
        pmx_mock.app_pair.return_value = {"success_screen": True, "steps": ["success"]}
        pmx_mock.glasses_bonds.return_value = [{"name": "Mentra_Live_E511"}]
        pmx_mock.presses.return_value = "DUDUDU"
        pmx_mock.ui_nodes.return_value = []
        ios_mock = mock.MagicMock()
        ios_mock.mac_sheet.return_value = None
        ios_mock.mac_bonded.return_value = True
        ios_mock.owner_lost_card.side_effect = [True, False, False, False, False]
        ios_mock.visible_texts.return_value = ["In pairing mode", "Pair again", "Press 3 times",
                                               "Forget in Settings"]
        ios_mock.pair_again_from_card.return_value = True
        ios_mock.glasses_mac.return_value = "aa-bb"
        patches = [
            mock.patch.object(cases, "pmx", pmx_mock),
            mock.patch.object(cases, "ios", ios_mock),
            mock.patch.object(cases.owner_lost, "owner_lost_on_notice", fake_owner_lost),
            mock.patch.object(cases, "time", types.SimpleNamespace(sleep=lambda *_: None, time=time.time,
                                                                   strftime=time.strftime)),
            mock.patch.object(cases, "r_s22", lambda ctx: True),
            mock.patch.object(cases, "r_ios", lambda ctx: True),
            mock.patch.object(cases, "await_live_link", lambda ctx, who, **k: "live"),
            mock.patch.object(cases, "own_probe", lambda ctx: {"own": 1, "line": "x"}),
            mock.patch.object(cases, "s22_holds_bond", lambda: True),
            mock.patch.object(cases, "s22_finish_setup", lambda: None),
            mock.patch.object(cases, "ios_pair", lambda ctx, timeout=180: (
                (time.time(), "owner committed"), {"success_screen": True, "pairing_info": 1, "steps": ["success"]})),
            mock.patch.object(cases, "ios_success_after_pairing_info", lambda ctx, im: True),
            mock.patch.object(cases, "mac_central", lambda *a, **k: [{"connected": True}]),
            mock.patch.object(cases.owner_lost, "observe_after_close", lambda ctx, res, seconds=30, **k: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.pmx, self.ios = pmx_mock, ios_mock

    def run_case(self, cid):
        cases.CASES[cid](self.ctx)
        bad = [c for c in self.ctx.checks if c["check"] in ("exception",)]
        self.assertEqual(bad, [])
        return self.ctx

    def assertAllOk(self, ctx):
        self.assertEqual(ctx.failed(), [], ctx.failed())

    def test_d4bfix(self):
        ctx = self.run_case("D4BFIX")
        self.assertAllOk(ctx)
        self.pmx.inject.assert_called()  # one 3-press gesture
        self.assertEqual(self.pmx.inject.call_count, 1)

    def test_x6_one_gesture_and_all_checks(self):
        ctx = self.run_case("X6")
        self.assertAllOk(ctx)
        self.assertEqual(self.pmx.inject.call_count, 1)
        self.assertIn("iOS Success only after pairing_info", ctx.ok_names())

    def test_x5(self):
        ctx = self.run_case("X5")
        self.assertAllOk(ctx)
        self.assertEqual(self.pmx.inject.call_count, 1)
        self.assertIn("S22 Success screen", ctx.ok_names())

    def test_x7a(self):
        self.ios.mac_bonded.return_value = None
        self.ios.mac_bonded.side_effect = [False, True]
        ctx = self.run_case("X7A")
        self.assertAllOk(ctx)
        self.assertEqual(self.pmx.inject.call_count, 1)
        self.assertIn("iOS owner again (Success + pairing_info)", ctx.ok_names())

    def test_x7a_not_testable_without_the_card(self):
        self.ios.owner_lost_card.side_effect = [False]
        self.run_case("X7A")
        self.assertIn("X5", self.ctx.untestable)

    def test_d4_x10_x11(self):
        for cid in ("D4", "X10", "X11"):
            ctx = GlueCtx(self.tmp, bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE])
            self.ctx = ctx
            cases.CASES[cid](ctx)
            self.assertEqual([c for c in ctx.checks if c["check"] == "exception"], [], cid)
            self.assertEqual(ctx.failed(), [], (cid, ctx.failed()))

    def test_d5d7_pairs_again_after_the_interval(self):
        card = types.SimpleNamespace(label="In pairing mode", center=(1, 1))
        self.pmx.ui_find.side_effect = [card, None, None, None]
        order = []
        self.pmx.tap_text.side_effect = lambda *a, **k: order.append("pair_again_tap") or True
        real = fake_owner_lost

        def spy(ctx, previous_owner, **kw):
            res = real(ctx, previous_owner, **kw)
            order.append(f"interval:{kw['scenario']}")
            return res

        with mock.patch.object(cases.owner_lost, "owner_lost_on_notice", spy):
            ctx = self.run_case("D5D7")
        self.assertAllOk(ctx)
        # Pair again is a separate step AFTER the owner-lost interval returned
        self.assertEqual(order[:2], ["interval:notice", "pair_again_tap"])
        self.assertIn("owner-lost card gone", ctx.ok_names())

    def test_btoff_rejoin(self):
        ctx = self.ctx = GlueCtx(self.tmp, bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE])
        ctx.adv = lambda seconds=5.0: {"mentra": {"pairing": True}}
        cases.CASES["BTOFF_REJOIN"](ctx)
        self.assertEqual(ctx.failed(), [], ctx.failed())

    def test_new8_cases(self):
        for cid in ("NEW8IOS", "NEW8S22"):
            ctx = GlueCtx(self.tmp)
            self.ctx = ctx
            self.pmx.ui_nodes.return_value = [types.SimpleNamespace(label="Press 3 times"),
                                              types.SimpleNamespace(label="In pairing mode")]
            self.pmx.tap_text.return_value = True
            cases.CASES[cid](ctx)
            self.assertEqual([c for c in ctx.checks if c["check"] == "exception"], [], cid)
            self.assertEqual(ctx.failed(), [], (cid, ctx.failed()))

    def test_subsumed_and_not_testable_cases_have_a_reason(self):
        for cid in ("D4B", "D4FIX", "X2", "D3", "NEW7"):
            ctx = GlueCtx(self.tmp)
            cases.CASES[cid](ctx)
            self.assertTrue(ctx.untestable, cid)
            self.assertEqual(ctx.checks, [], cid)


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def time(self):
        return self.now

    def sleep(self, s):
        self.now += s


class RingHelperTests(unittest.TestCase):
    LINES = [
        "100 | lxy pair: pwr_press st=OWNER_ONLY exp=1 own=0/0 clicks=1/3 fired=0 ind=0 lock=1 generation=72 cand=0 conidx=0",
        "200 | lxy pair: mode_enter_done st=PAIRING exp=1 own=0/0 clicks=3/3 fired=1 ind=1 lock=0 generation=73 cand=0 conidx=255",
        "300 | lxy pair: no owner at MTK ready, auto-enter pairing",
    ]

    def test_tick_and_generation_helpers(self):
        ctx = h.FakeCtx(bes_lines=self.LINES)
        self.assertEqual(cases.ring_tick(self.LINES[0]), 100)
        self.assertIsNone(cases.ring_tick("garbage"))
        self.assertEqual(cases.ring_generation(ctx), (200, 73))
        self.assertEqual(cases.ring_after_tick(ctx, 150, r"mode_enter_done|auto-enter"), self.LINES[1:])
        self.assertEqual(cases.ring_after_tick(ctx, 250, r"mode_enter_done|auto-enter"), self.LINES[2:])

    def test_tick_floor_resets_when_bes_itself_rebooted(self):
        ctx = h.FakeCtx(bes_lines=self.LINES)
        self.assertEqual(cases.tick_floor(ctx, 150), 150)   # ticks continue: Android-only reboot
        self.assertEqual(cases.tick_floor(ctx, 5_000_000), 0)  # ticks restarted: BES rebooted


class A5GlueTests(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.tmp = tempfile.mkdtemp()
        self.clock = FakeClock()
        self.pmx = mock.MagicMock(unsafe=True)
        self.pmx.app_pair.return_value = {"success_screen": True, "steps": ["success"]}
        self.pmx.wait_glasses_boot.return_value = True
        self.ios = mock.MagicMock()
        patches = [
            mock.patch.object(cases, "pmx", self.pmx),
            mock.patch.object(cases, "ios", self.ios),
            mock.patch.object(cases, "time", types.SimpleNamespace(sleep=self.clock.sleep, time=self.clock.time,
                                                                   strftime=time.strftime)),
            mock.patch.object(cases, "own_probe", lambda ctx: {"own": 0, "line": "x"} if not getattr(ctx, "paired", 0)
                              else {"own": 1, "line": "own=1/1"}),
            mock.patch.object(cases, "s22_holds_bond", lambda: bool(getattr(self.ctx, "paired", 0))),
            mock.patch.object(cases, "s22_finish_setup", lambda: None),
            mock.patch.object(cases, "wait_owner_link", lambda ctx, mark, timeout=60: (1, "ready")),
            mock.patch.object(cases, "no_owner_loss", lambda ctx, mark: None),
            mock.patch.object(cases, "await_live_link", lambda ctx, who, **k: "live"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def make_ctx(self, bes_lines):
        ctx = self.ctx = GlueCtx(self.tmp, bes_lines=bes_lines)
        ctx.p = types.SimpleNamespace(mark=lambda: 0, since=lambda m: [])
        ctx.dir = Path(self.tmp)
        self.pmx.LogTap.return_value.start.return_value = ctx.g
        ctx.adv = lambda seconds=5.0: {"mentra": {"pairing": not getattr(ctx, "paired", 0)}}

        def bes_wait(pattern, timeout, mark=None):
            ctx.paired = 1
            return (self.clock.time(), "300 | lxy pair: owner committed from ble bond")

        ctx.bes_wait = bes_wait
        return ctx

    def test_android_reboot_without_an_auto_window_is_an_open_gap_not_a_pass_or_fail(self):
        ctx = self.make_ctx(["100 | lxy pair: pwr_press st=OWNER_ONLY exp=1 own=0/0 clicks=1/3 fired=0 ind=0 lock=1 generation=72 cand=0 conidx=0"])
        cases.CASES["A5"](ctx)
        self.assertEqual([g["gap"] for g in ctx.gaps], ["A5 auto window after an Android-only reboot"])
        self.assertEqual([c for c in ctx.checks if c["check"] == "exception"], [])
        self.assertEqual(ctx.failed(), [], ctx.failed())

    POST_REBOOT = [
        "900 | lxy pair: no owner at MTK ready, auto-enter pairing",
        "901 | lxy pair: mode_enter_done st=PAIRING exp=1 own=0/0 clicks=0/3 fired=0 ind=1 lock=0 generation=73 cand=0 conidx=255",
    ]
    PRE = ["100 | lxy pair: pwr_press st=OWNER_ONLY exp=1 own=0/0 clicks=1/3 fired=0 ind=0 lock=1 generation=72 cand=0 conidx=0"]

    def reboot_adds(self, ctx, lines):
        def boot(timeout=240):
            ctx.g.bes_lines.extend(lines)
            return True
        self.pmx.wait_glasses_boot.side_effect = boot

    def test_one_auto_window_then_pair_then_second_disconnect_stays_closed(self):
        ctx = self.make_ctx(list(self.PRE))
        self.reboot_adds(ctx, self.POST_REBOOT)
        cases.CASES["A5"](ctx)
        self.assertEqual(ctx.gaps, [])
        self.assertEqual(ctx.failed(), [], ctx.failed())
        self.assertIn("exactly one auto-enter at MTK-ready", ctx.ok_names())
        self.assertIn("second disconnect in the same boot did not reopen a window", ctx.ok_names())

    def test_a_second_window_after_the_second_disconnect_fails(self):
        ctx = self.make_ctx(list(self.PRE))
        self.reboot_adds(ctx, self.POST_REBOOT)

        def bt(enabled):
            if not enabled:
                ctx.g.bes_lines.append("2000 | lxy pair: mode_enter_done st=PAIRING exp=1 own=0/0 clicks=3/3 fired=1 ind=1 lock=0 generation=74 cand=0 conidx=255")
        self.pmx.phone_bt.side_effect = bt
        cases.CASES["A5"](ctx)
        self.assertIn("second disconnect in the same boot did not reopen a window", ctx.failed())

    def test_two_auto_enters_in_one_boot_fail(self):
        ctx = self.make_ctx(list(self.PRE))
        self.reboot_adds(ctx, self.POST_REBOOT + ["905 | lxy pair: no owner at MTK ready, auto-enter pairing"])
        cases.CASES["A5"](ctx)
        self.assertIn("exactly one auto-enter at MTK-ready", ctx.failed())


class B5B6GlueTests(unittest.TestCase):
    """A simulated BES ring: every press gesture of 3+ opens a window (generation +1), a click closes it (+1)."""

    def setUp(self):
        import tempfile

        self.tmp = tempfile.mkdtemp()
        self.state = {"gen": 72, "tick": 1000, "open": False}
        self.pmx = mock.MagicMock(unsafe=True)
        self.ios = mock.MagicMock()
        self.pmx.presses.side_effect = lambda n, gap=300: f"P{n}"
        patches = [
            mock.patch.object(cases, "pmx", self.pmx),
            mock.patch.object(cases, "ios", self.ios),
            mock.patch.object(cases, "time", types.SimpleNamespace(sleep=lambda *_: None, time=time.time,
                                                                   strftime=time.strftime)),
            mock.patch.object(cases, "make_s22_owner", lambda ctx: True),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def line(self, tag):
        st = self.state
        st["tick"] += 50
        return (f"{st['tick']} | lxy pair: {tag} st={'PAIRING' if st['open'] else 'OWNER_ONLY'} exp=1 own=0/0 "
                f"clicks=0/3 fired=0 ind=1 lock=0 generation={st['gen']} cand=0 conidx=255")

    def test_five_presses_prove_one_entry_by_generation_and_adv(self):
        ctx = GlueCtx(self.tmp, bes_lines=[self.line("pwr_press")])
        st = self.state

        def inject(seq, *a, **k):
            if seq == "C":
                st["gen"] += 1
                st["open"] = False
                ctx.g.bes_lines.append(self.line("window_close"))
            elif seq.startswith("P"):
                st["gen"] += 1
                st["open"] = True
                ctx.g.bes_lines.append(self.line("mode_enter_done"))

        self.pmx.inject.side_effect = inject
        ctx.adv = lambda seconds=5.0: {"mentra": {"pairing": st["open"]}}

        def enter_pairing(ctx, n=3, gap_ms=300):
            inject("P3")
            return ctx.g.mark()

        def bes_wait(pattern, timeout, mark=None):
            inject("P3") if False else None
            line = self.line("mode_enter_done")
            ctx.g.bes_lines.append(line)
            return (time.time(), line)

        ctx.bes_wait = bes_wait
        with mock.patch.object(cases, "enter_pairing", enter_pairing), \
                mock.patch.object(cases, "open_window", lambda ctx, delay_ms=0, settle=True: (st.update(gen=st["gen"] + 1, open=True), ctx.g.bes_lines.append(self.line("mode_enter_done")))):
            cases.CASES["B5B6"](ctx)
        self.assertEqual([c for c in ctx.checks if c["check"] == "exception"], [])
        names = ctx.ok_names()
        for n in (4, 5):
            self.assertIn(f"{n} presses -> exactly one window generation (+1)", names)
            self.assertIn(f"{n} presses -> advertisement shows the pairing window", names)
            self.assertIn(f"{n} presses -> window closed by the single click", names)

    def test_two_entries_from_five_presses_fail(self):
        ctx = GlueCtx(self.tmp, bes_lines=[self.line("pwr_press")])
        st = self.state
        calls = {"n": 0}

        def inject(seq, *a, **k):
            if seq.startswith("P"):
                calls["n"] += 1
                bump = 2 if seq == "P5" else 1  # the bug under test: a double entry
                st["gen"] += bump
                st["open"] = True
                for _ in range(bump):
                    ctx.g.bes_lines.append(self.line("mode_enter_done"))
            elif seq == "C":
                st["gen"] += 1
                st["open"] = False

        self.pmx.inject.side_effect = inject
        ctx.adv = lambda seconds=5.0: {"mentra": {"pairing": st["open"]}}
        with mock.patch.object(cases, "enter_pairing", lambda ctx, n=3, gap_ms=300: ctx.g.mark()), \
                mock.patch.object(cases, "open_window", lambda ctx, delay_ms=0, settle=True: True):
            cases.CASES["B5B6"](ctx)
        self.assertIn("5 presses -> exactly one window generation (+1)", ctx.failed())


if __name__ == "__main__":
    unittest.main()
