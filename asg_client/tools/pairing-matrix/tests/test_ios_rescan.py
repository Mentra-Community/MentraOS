"""ios.pair stale-advert rescan, window-closed early stop, and the no-extra-presses rule (fakes only)."""

import re
import types
import unittest
from pathlib import Path
from unittest import mock

from tests import helpers as h
import cases
import ident
import ios


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps = 0

    def time(self):
        return self.now

    def sleep(self, s):
        self.now += s
        self.sleeps += 1


class Screen:
    """Scripted scan screen. `labels` is what a WDA predicate can see."""

    STALE = "Mentra Live, E511 · Not in pairing mode"

    def __init__(self, clock, labels=None):
        self.clock = clock
        self.labels = list(labels if labels is not None else [self.STALE, "Back", "Choose your glasses"])
        self.picked = False
        self.taps = []
        self.try_again_works = False
        self.reopen_fixes = 1  # the Nth reopen makes the row pairable (0 = never)
        self.reopens = 0
        self.tap_times = []

    def find(self, pattern):
        for lab in self.labels:
            if re.fullmatch(pattern.replace("^", "").replace("$", ""), lab, re.I):
                return types.SimpleNamespace(label=lab)
        return None

    def tap(self, el):
        self.taps.append(el.label)
        if re.fullmatch(r"(Mentra Live, )?E511", el.label):
            self.picked = True
            self.labels = ["Success"]

    def tap_text(self, pattern, timeout=10):
        key = pattern.strip("^$")
        self.taps.append(key)
        self.tap_times.append((key, self.clock.time()))
        if key == "Try Again" and "Try Again" in self.labels:
            if self.try_again_works:
                self.labels = ["Mentra Live, E511", "Back"]
            return True
        if key == "Back":
            return True
        return False

    def open_pairing_scan(self):
        self.reopens += 1
        self.tap_times.append(("reopen", self.clock.time()))
        if self.reopen_fixes and self.reopens >= self.reopen_fixes:
            self.labels = ["Mentra Live, E511", "Back", "Choose your glasses"]
        else:
            self.labels = [self.STALE, "Back", "Choose your glasses"]
        return True


class IosPairTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.screen = Screen(self.clock)
        ident.set_for_tests(ident.Identity("Mentra_Live_E511", "E511", ""))
        self.addCleanup(ident.set_for_tests, None)
        s = self.screen
        patches = [
            mock.patch.object(ios, "time", types.SimpleNamespace(time=self.clock.time, sleep=self.clock.sleep)),
            mock.patch.object(ios, "find", s.find),
            mock.patch.object(ios, "tap", s.tap),
            mock.patch.object(ios, "tap_text", s.tap_text),
            mock.patch.object(ios, "open_pairing_scan", s.open_pairing_scan),
            mock.patch.object(ios, "handle_alert", lambda *a, **k: None),
            mock.patch.object(ios, "visible_texts", lambda: ["Choose your glasses"] + s.labels),
            mock.patch.object(ios, "mac_sheet", lambda: None),
            mock.patch.object(ios, "bridge_running", lambda: True),
            mock.patch.object(ios, "bridge", lambda enabled: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_stale_advert_then_rescan_then_pick(self):
        opens = []
        res = ios.pair(timeout=180, window_open=lambda: opens.append(self.clock.time()) or True,
                       window_closed=lambda: None)
        self.assertIn("rescan:1", res["steps"])
        self.assertIn("rescan:1:reopen:True", res["steps"])
        self.assertIn("picked:E511", res["steps"])
        self.assertTrue(res["success_screen"])
        self.assertEqual(res["rescans"], 1)
        self.assertEqual(len(opens), 1)
        # the stale row has to be seen for >= 8 s before the first rescan
        self.assertGreaterEqual(self.screen.tap_times[1][1] - 1000.0, 8.0)
        self.assertEqual(self.screen.reopens, 1)

    def test_try_again_is_used_first_when_present(self):
        self.screen.labels = [Screen.STALE, "Try Again", "Back"]
        self.screen.try_again_works = True
        res = ios.pair(timeout=180, window_open=lambda: True)
        self.assertIn("rescan:1:try_again", res["steps"])
        self.assertEqual(self.screen.reopens, 0)
        self.assertTrue(res["success_screen"])

    def test_at_most_three_rescans_at_least_ten_seconds_apart(self):
        self.screen.reopen_fixes = 0  # never becomes pairable
        res = ios.pair(timeout=120, window_open=lambda: True)
        reopens = [t for k, t in self.screen.tap_times if k == "reopen"]
        self.assertEqual(res["rescans"], 3)
        self.assertEqual(len(reopens), 3)
        self.assertTrue(all(b - a >= 10 for a, b in zip(reopens, reopens[1:])), reopens)
        self.assertFalse(res["success_screen"])
        self.assertNotIn("picked:E511", res["steps"])

    def test_no_rescan_when_the_advert_says_the_window_is_not_open(self):
        calls = []
        res = ios.pair(timeout=40, window_open=lambda: calls.append(1) or False)
        self.assertEqual(res["rescans"], 0)
        self.assertEqual(self.screen.reopens, 0)
        self.assertIn("rescan_skipped:advert_not_pairing", res["steps"])
        self.assertLessEqual(len(calls), 4)  # throttled, not one Mac scan per second

    def test_window_closed_before_pick_stops_early_with_a_clear_result(self):
        self.screen.reopen_fixes = 0
        state = {"n": 0}

        def closed():
            state["n"] += 1
            return "hm_pairexit received reason=idle_timeout" if self.clock.time() - 1000 > 30 else None

        res = ios.pair(timeout=180, window_open=lambda: True, window_closed=closed)
        self.assertIn("window closed before pick", res["aborted"])
        self.assertIn("idle_timeout", res["window_closed_before_pick"])
        self.assertIn("window_closed_before_pick", res["steps"])
        self.assertLess(self.clock.time() - 1000, 60)  # nowhere near the 180 s timeout

    def test_window_closed_is_ignored_after_the_pick(self):
        self.screen.labels = ["Mentra Live, E511", "Back"]
        res = ios.pair(timeout=60, window_open=lambda: True, window_closed=lambda: "window_close reason=paired")
        # the pick happens in the first iteration, before any closed check can end the run
        self.assertIn("picked:E511", res["steps"])
        self.assertTrue(res["success_screen"])
        self.assertNotIn("window_closed_before_pick", res["steps"])

    def test_legacy_behavior_without_hooks_taps_try_again_only(self):
        self.screen.labels = [Screen.STALE, "Try Again"]
        res = ios.pair(timeout=20)
        self.assertEqual(res["rescans"], 0)
        self.assertIn("try_again", res["steps"])
        self.assertEqual(self.screen.reopens, 0)

    def test_other_glasses_not_in_pairing_mode_row_is_not_a_stale_advert(self):
        self.screen.labels = ["Mentra Live, D6B8 · Not in pairing mode", "Back"]
        res = ios.pair(timeout=40, window_open=lambda: True)
        self.assertEqual(res["rescans"], 0)

    def test_ios_module_never_presses_the_glasses(self):
        src = (Path(ios.__file__)).read_text()
        self.assertNotIn("inject", src)
        self.assertNotIn("presses(", src)


class HookTests(unittest.TestCase):
    def setUp(self):
        self.pmx = mock.MagicMock()
        self.clock = Clock()
        patches = [mock.patch.object(cases, "pmx", self.pmx),
                   mock.patch.object(cases, "time", types.SimpleNamespace(time=self.clock.time, sleep=self.clock.sleep,
                                                                          strftime=lambda *a: "t"))]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def ctx(self, bes=(), logs=()):
        c = h.FakeCtx(bes_lines=list(bes), log_lines=list(logs))
        return c

    def test_window_open_needs_the_advertisement_pairing_flag(self):
        hooks = cases.ios_pair_hooks(self.ctx(), 0)
        self.pmx.glasses_adv.return_value = {"mentra": {"pairing": True}}
        self.assertTrue(hooks["window_open"]())
        self.pmx.glasses_adv.return_value = {"mentra": {"pairing": False}}
        self.assertFalse(hooks["window_open"]())
        self.pmx.glasses_adv.return_value = None
        self.assertFalse(hooks["window_open"]())

    def test_window_closed_by_bes_lines(self):
        self.pmx.glasses_adv.return_value = {"mentra": {"pairing": True}}
        hooks = cases.ios_pair_hooks(self.ctx(bes=["1 | lxy pair: window_close reason=idle_timeout"]), 0)
        self.assertIn("idle_timeout", hooks["window_closed"]())
        hooks = cases.ios_pair_hooks(self.ctx(logs=["I/PairingAudio: hm_pairexit received reason=idle_timeout"]), 0)
        self.assertIn("idle_timeout", hooks["window_closed"]())

    def test_advertisement_flag_cleared_twice_closes_but_once_does_not(self):
        self.pmx.glasses_adv.return_value = {"mentra": {"pairing": False}}
        hooks = cases.ios_pair_hooks(self.ctx(), 0)
        self.assertIsNone(hooks["window_closed"]())      # first sighting only
        self.clock.sleep(11)
        self.assertEqual(hooks["window_closed"](), "advertisement pairing flag cleared")

    def test_open_advertisement_resets_the_clear_counter(self):
        hooks = cases.ios_pair_hooks(self.ctx(), 0)
        self.pmx.glasses_adv.return_value = {"mentra": {"pairing": False}}
        hooks["window_closed"]()
        self.clock.sleep(11)
        self.pmx.glasses_adv.return_value = {"mentra": {"pairing": True}}
        self.assertIsNone(hooks["window_closed"]())
        self.clock.sleep(11)
        self.pmx.glasses_adv.return_value = {"mentra": {"pairing": False}}
        self.assertIsNone(hooks["window_closed"]())

    def test_hooks_never_press_the_glasses(self):
        self.pmx.glasses_adv.return_value = {"mentra": {"pairing": True}}
        hooks = cases.ios_pair_hooks(self.ctx(), 0)
        hooks["window_open"]()
        hooks["window_closed"]()
        self.pmx.inject.assert_not_called()

    def test_ios_pair_passes_the_hooks_and_flags_a_closed_window(self):
        ctx = h.FakeCtx()
        ctx.i = types.SimpleNamespace(mark=lambda: 0, grep=lambda *a, **k: [])
        ctx.ishot = lambda name: None
        ctx.bes_wait = lambda *a, **k: None
        seen = {}

        def fake_pair(timeout=75, **kw):
            seen.update(kw)
            return {"success_screen": False, "steps": ["scan:True"], "rescans": 1,
                    "window_closed_before_pick": "window_close reason=idle_timeout"}

        with mock.patch.object(cases.ios, "pair", fake_pair), \
                mock.patch.object(cases.ios, "finish_setup", lambda: None), \
                mock.patch.object(cases.ios, "require_fresh_advert", lambda: {"last_seen": 0}):
            commit, res = cases.ios_pair(ctx)
        self.assertEqual(sorted(seen), ["window_closed", "window_open"])
        self.assertIn("iOS picked the glasses before the window closed", ctx.failed())
        self.pmx.inject.assert_not_called()
        self.assertEqual(self.pmx.mock_calls and [c for c in self.pmx.mock_calls if "inject" in str(c)], [])


class CallerCoverageTests(unittest.TestCase):
    def test_every_scan_then_pick_flow_goes_through_the_hooked_helpers(self):
        text = Path(cases.__file__).read_text()
        direct = re.findall(r"ios\.pair\(([^)]*)\)", text)
        # E1 (iOS stranger outside any window) stays legacy on purpose; every other direct call passes the hooks.
        legacy = [d for d in direct if "ios_pair_hooks" not in d]
        self.assertEqual(legacy, ["timeout=40"], legacy)
        for name in ("r_ios", "x1_first_ios_pair", "new3_classic_first", "x7a_settings_detour", "o4_s22_owner_ios_takes_over",
                     "x9_back_and_forth"):
            self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()
