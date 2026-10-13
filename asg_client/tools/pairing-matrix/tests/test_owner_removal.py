"""Owner-removal proof rule (c): a BES owner-record line of the same event, with a greater window generation."""

import time
import unittest

from tests import helpers as h
from tests.test_owner_lost import notice_script, run
import owner_lost

# Real shape of runs/x2/D4BFIX/bes_trace.txt: mode_enter_done was dropped by the ring.
D4BFIX = [
    "1619882 | lxy pair: pwr_press st=OWNER_ONLY exp=1 own=1/1 clicks=1/3 fired=0 ind=0 lock=0 generation=3 cand=0 conidx=255",
    "1623991 | lxy pair: click_window_end st=OWNER_ONLY exp=1 own=1/1 clicks=0/3 fired=0 ind=0 lock=0 generation=3 cand=0 conidx=255",
    "370 | lxy pair: ble_connect st=PAIRING exp=1 own=0/0 clicks=3/3 fired=1 ind=1 lock=0 generation=4 cand=0 conidx=255",
    "1645417 | lxy pair: click_window_end st=PAIRING exp=1 own=0/0 clicks=0/3 fired=0 ind=0 lock=1 generation=4 cand=0 conidx=0",
    "1654590 | lxy pair: ble_bond st=PAIRING exp=1 own=0/0 clicks=0/3 fired=0 ind=0 lock=1 generation=4 cand=0 conidx=0",
    "1654605 | lxy pair: owner committed from ble bond",
    "1670990 | lxy pair: ble_disconnect st=OWNER_ONLY exp=1 own=1/0 clicks=0/3 fired=0 ind=0 lock=0 generation=4 cand=0 conidx=255",
]


def st(tag, state, own, gen, tick=1):
    return (f"{tick} | lxy pair: {tag} st={state} exp=1 own={own} clicks=0/3 fired=0 ind=0 lock=0 "
            f"generation={gen} cand=0 conidx=255")


class TransitionTests(unittest.TestCase):
    def test_positive_d4bfix_trace(self):
        t = owner_lost.owner_removal_transitions(D4BFIX)
        self.assertEqual(len(t), 1)
        self.assertIn("1623991", t[0][0])
        self.assertIn("ble_connect st=PAIRING", t[0][1])  # first own=0/0 PAIRING line with generation 4

    def test_same_generation_does_not_count(self):
        lines = [st("click_window_end", "OWNER_ONLY", "1/1", 3), st("click_window_end", "PAIRING", "0/0", 3)]
        self.assertEqual(owner_lost.owner_removal_transitions(lines), [])

    def test_earlier_window_lines_before_the_owner_line_do_not_count(self):
        lines = [st("ble_connect", "PAIRING", "0/0", 2), st("ble_bond", "PAIRING", "0/0", 3),
                 st("session_up", "OWNER_ONLY", "1/1", 3)]
        self.assertEqual(owner_lost.owner_removal_transitions(lines), [])

    def test_no_pre_entry_owner_line_means_no_proof(self):
        lines = [st("pwr_press", "OWNER_ONLY", "0/0", 3), st("ble_connect", "PAIRING", "0/0", 4)]
        self.assertEqual(owner_lost.owner_removal_transitions(lines), [])

    def test_lower_generation_does_not_count(self):
        lines = [st("pwr_press", "OWNER_ONLY", "1/1", 5), st("ble_connect", "PAIRING", "0/0", 4)]
        self.assertEqual(owner_lost.owner_removal_transitions(lines), [])

    def test_non_pairing_state_does_not_count(self):
        lines = [st("pwr_press", "OWNER_ONLY", "1/1", 3), st("click_window_end", "OWNER_ONLY", "0/0", 4)]
        self.assertEqual(owner_lost.owner_removal_transitions(lines), [])

    def test_unparsable_and_non_state_lines_are_skipped(self):
        lines = ["garbage", "100 | lxy pair: owner committed from ble bond"] + D4BFIX
        self.assertEqual(len(owner_lost.owner_removal_transitions(lines)), 1)


class AssertionTests(unittest.TestCase):
    def go(self, bes, **kw):
        ctx = h.FakeCtx(bes_lines=bes)
        probe = h.FakeProbe(notice_script(), card_after=0.1)
        res = run(ctx, probe, **kw)
        return ctx, res

    def test_d4bfix_trace_proves_removal_without_mode_enter_done(self):
        ctx, res = self.go(D4BFIX)
        a = next(a for a in res.assertions if a.name.startswith("4b"))
        self.assertTrue(a.ok, a.detail)
        self.assertEqual(a.source, "bes owner record (generation advanced)")
        self.assertNotIn("R15 4b previous owner removed (R4)", [g["gap"] for g in ctx.gaps])

    def test_same_generation_stays_a_gap(self):
        bes = [st("pwr_press", "OWNER_ONLY", "1/1", 3), st("ble_connect", "PAIRING", "0/0", 3)]
        ctx, _ = self.go(bes)
        self.assertIn("R15 4b previous owner removed (R4)", [g["gap"] for g in ctx.gaps])

    def test_no_pre_entry_owner_line_stays_a_gap(self):
        bes = [st("ble_connect", "PAIRING", "0/0", 4), st("ble_bond", "PAIRING", "0/0", 4)]
        ctx, _ = self.go(bes)
        self.assertIn("R15 4b previous owner removed (R4)", [g["gap"] for g in ctx.gaps])

    def test_mode_enter_done_with_owner_still_recorded_is_still_a_failure(self):
        bes = [h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE.replace("own=0/0", "own=1/1")] + D4BFIX
        ctx, _ = self.go(bes)
        self.assertIn("R15 4b previous owner removed (R4)", ctx.failed())

    def test_existing_rule_a_still_preferred(self):
        ctx, res = self.go([h.BES_PRE_OWNER, h.BES_ENTER, h.BES_ENTER_DONE, h.BES_COMMIT])
        a = next(a for a in res.assertions if a.name.startswith("4b"))
        self.assertEqual(a.source, "bes")


if __name__ == "__main__":
    unittest.main()
