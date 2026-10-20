"""OS-2055 v4 transition cases (O1..O6 and the flag-off regression V4OFF): registration, the MENTRA_TRANSFER switch,
the fault-injection declaration, the superseded T0..T9 stubs and the V4OFF wire scan.
No device is touched: the cases that would drive hardware stop at require_transfer / not_testable here."""

import os
import re
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from tests import helpers as h
import cases

# V6 row -> case ids (see the block comment above TRANSFER_ENV in cases.py)
O_ROWS = {
    "O1": ["O1_S22", "O1_IOS", "O1_BTOFF", "O1_GRACE"],
    "O2": ["O2_S22", "O2_IOS", "B11"],
    "O3a": ["O3A_S22"],
    "O3b": ["O3B_IOS"],
    "O4": ["O4_S22_MAC", "O4_S22_IOS", "O4_IOS_S22", "D5D7"],
    "O5": ["O5_STEP1", "O5_STEP2", "O5_STEP3", "O5_WINDOW", "O5_PRECOMMIT"],
    "O6": ["O6_MAC"],
}
NEW_IDS = [cid for ids in O_ROWS.values() for cid in ids] + ["V4OFF"]
V4_ONLY = [cid for cid in NEW_IDS if cid not in ("V4OFF", "O5_PRECOMMIT")]
OLD_IDS = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9",
           "D4", "D4B", "D4FIX", "D4BFIX", "BTOFF_REJOIN", "BTOFF_REJOIN_LOCKED", "X5", "X6", "X10", "X11"]


class TapStub:
    def __init__(self, lines=None):
        self.lines = list(lines or [])

    def mark(self):
        return 0

    def since(self, mark):
        return [(time.time(), l) for l in self.lines[mark:]]


class TransferCtx(h.FakeCtx):
    def __init__(self, bes_lines=None, asg=None, phone=None, ios_lines=None):
        super().__init__(bes_lines=bes_lines, log_lines=asg)
        self.p = TapStub(phone)
        self.i = TapStub(ios_lines)
        self.untestable = ""
        self.g.since = lambda m: [(time.time(), l) for l in self.g.log_lines]

    def not_testable(self, why):
        self.untestable = why

    def bes_wait(self, pattern, timeout, mark=None):
        hits = [l for l in self.g.bes_lines if re.search(pattern, l)]
        return (time.time(), hits[-1]) if hits else None


def with_mode(value):
    env = {} if value is None else {cases.TRANSFER_ENV: value}
    return mock.patch.dict(os.environ, env if value is not None else {}, clear=False)


class RegistrationTests(unittest.TestCase):
    def test_all_v4_cases_register_with_docstrings(self):
        for cid in NEW_IDS:
            self.assertIn(cid, cases.CASES, cid)
            self.assertTrue(cases.CASES[cid].__doc__, cid)

    def test_ids_are_unique_in_the_source(self):
        text = Path(cases.__file__).read_text()
        ids = re.findall(r'^@case\("([^"]+)"\)', text, re.M)
        self.assertEqual(sorted({i for i in ids if ids.count(i) > 1}), [])
        # O5_STEP1..3 are registered by a loop; the rest have exactly one decorator
        for cid in NEW_IDS:
            if not cid.startswith("O5_STEP"):
                self.assertEqual(ids.count(cid), 1, cid)

    def test_no_id_is_both_a_live_case_and_a_superseded_stub(self):
        text = Path(cases.__file__).read_text()
        stubs = re.findall(r'^superseded\("([^"]+)"', text, re.M)
        live = re.findall(r'^@case\("([^"]+)"\)', text, re.M)
        self.assertEqual(sorted(set(stubs) & set(live)), [])

    def test_every_o_row_has_a_case(self):
        self.assertEqual(sorted(O_ROWS), ["O1", "O2", "O3a", "O3b", "O4", "O5", "O6"])
        for row, ids in O_ROWS.items():
            self.assertTrue(ids, row)

    def test_removed_ids_resolve_to_a_live_replacement(self):
        for cid in OLD_IDS:
            self.assertIn(cid, cases.CASES, cid)
            doc = cases.CASES[cid].__doc__
            self.assertTrue(doc.startswith("SUPERSEDED by "), cid)
            self.assertIn(doc.split()[2].rstrip(":"), cases.CASES, cid)
            ctx = TransferCtx()
            cases.CASES[cid](ctx)
            self.assertIn("SUPERSEDED by", ctx.untestable, cid)
            self.assertEqual(ctx.checks, [], cid)


class ModeTests(unittest.TestCase):
    def test_default_is_on(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(cases.TRANSFER_ENV, None)
            self.assertEqual(cases.transfer_mode(), "on")
            self.assertTrue(cases.transfer_on())

    def test_on_and_off_are_case_insensitive(self):
        with with_mode(" ON "):
            self.assertEqual(cases.transfer_mode(), "on")
        with with_mode("off"):
            self.assertEqual(cases.transfer_mode(), "off")

    def test_anything_else_is_an_error(self):
        with with_mode("1"), self.assertRaises(ValueError):
            cases.transfer_mode()

    def test_v4_cases_are_not_testable_when_off(self):
        for cid in V4_ONLY:
            ctx = TransferCtx()
            with with_mode("off"):
                cases.CASES[cid](ctx)
            self.assertIn("MENTRA_TRANSFER=on", ctx.untestable, cid)
            self.assertEqual(ctx.checks, [], cid)

    def test_v4off_is_not_testable_when_on(self):
        ctx = TransferCtx()
        with with_mode("on"):
            cases.CASES["V4OFF"](ctx)
        self.assertIn("MENTRA_TRANSFER=off", ctx.untestable)

    def test_o5_precommit_is_documented_not_injectable(self):
        ctx = TransferCtx()
        cases.CASES["O5_PRECOMMIT"](ctx)
        self.assertIn("no fault point", ctx.untestable)

    def test_o5_steps_need_the_matching_declared_debug_build(self):
        for step in (1, 2, 3):
            ctx = TransferCtx()
            with with_mode("on"), mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop(cases.FAULT_ENV, None)
                cases.CASES[f"O5_STEP{step}"](ctx)
            self.assertIn(f"{cases.FAULT_ENV}={step}", ctx.untestable)
        ctx = TransferCtx()
        with with_mode("on"), mock.patch.dict(os.environ, {cases.FAULT_ENV: "3"}):
            cases.CASES["O5_STEP2"](ctx)
        self.assertIn("declares 3", ctx.untestable)

    def test_fault_inject_declaration_is_validated(self):
        with mock.patch.dict(os.environ, {cases.FAULT_ENV: "0"}), self.assertRaises(ValueError):
            cases.fault_inject_step()
        with mock.patch.dict(os.environ, {cases.FAULT_ENV: "2"}):
            self.assertEqual(cases.fault_inject_step(), 2)
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(cases.FAULT_ENV, None)
            self.assertIsNone(cases.fault_inject_step())

    def test_fault_log_regex_matches_the_bes_line(self):
        line = "910 | lxy pair: fault inject reboot after commit step 2"
        self.assertEqual(re.search(cases.FAULT_LOG_RX, line).group(1), "2")


class WireScanTests(unittest.TestCase):
    def leaks(self, **kw):
        return cases.wire_hits(TransferCtx(**kw), cases.TRANSFER_KEY_RX)

    def test_flag_off_json_has_no_v4_keys(self):
        ph = ['I/Bridge: pairing_info {"secure_pairing_capable":true,"protocol_version":2,"owner_committed":true}',
              "I/Bridge: LIVE: Glasses entering pairing mode"]
        self.assertEqual(self.leaks(phone=ph), [])

    def test_each_v4_key_is_caught_in_any_source(self):
        self.assertTrue(self.leaks(phone=['{"pairing_mode_ended": {"reason":"timeout"}}']))
        self.assertTrue(self.leaks(asg=['send {\\"window_id\\":7}']))
        self.assertTrue(self.leaks(ios_lines=["PAIRFLOW: owner_changed=true"]))
        self.assertTrue(self.leaks(phone=['{"phone_hello":{"pairing_protocol":4}}']))

    def test_the_removed_protocol3_keys_are_not_the_scan_any_more(self):
        self.assertEqual(self.leaks(phone=['{"owner_retained":true,"awaiting_confirm":false}']), [])

    def test_protocol_version_regex(self):
        line = 'pairing_info {"protocol_version":4}'
        self.assertEqual(cases.PROTOCOL_VERSION_RX.search(line).group(1), "4")


class V4OffTests(unittest.TestCase):
    LEGACY_BES = [
        "100 | lxy pair: mode_enter_done st=PAIRING exp=1 own=0/0 clicks=3/3 fired=1 ind=1 lock=0 generation=2 cand=0 conidx=255",
        "200 | lxy pair: cancel by single click",
    ]

    def run_case(self, phone, bes=None):
        ctx = TransferCtx(bes_lines=self.LEGACY_BES if bes is None else bes, phone=phone)
        stub = lambda *a, **k: None  # noqa: E731
        with with_mode("off"), \
                mock.patch.object(cases, "stage_old_owner", stub), \
                mock.patch.object(cases, "open_window", stub), \
                mock.patch.object(cases, "pmx", mock.MagicMock()), \
                mock.patch.object(cases, "time", types.SimpleNamespace(sleep=lambda *_: None, time=time.time)):
            cases.CASES["V4OFF"](ctx)
        return ctx

    CLEAN = ['I/Bridge: pairing_info {"protocol_version":2,"owner_committed":true}',
             "I/Bridge: LIVE: Glasses entering pairing mode"]

    def test_legacy_behavior_with_clean_logs_passes_with_no_gap(self):
        ctx = self.run_case(self.CLEAN)
        self.assertEqual(ctx.failed(), [])
        self.assertEqual(ctx.gaps, [])
        names = ctx.ok_names()
        self.assertIn("legacy forget-on-entry (own=0/0)", names)
        self.assertIn("legacy single click closes the window", names)
        self.assertIn("pairing_info protocol_version stays 2", names)

    def test_a_retained_owner_on_entry_fails_the_flag_off_regression(self):
        bes = [self.LEGACY_BES[0].replace("own=0/0", "own=1/1"), "110 | lxy pair: xfer enter, owner retained",
               self.LEGACY_BES[1]]
        ctx = self.run_case(self.CLEAN, bes=bes)
        failed = " ".join(ctx.failed())
        self.assertIn("legacy forget-on-entry", failed)
        self.assertIn("no v4 retain on entry", failed)

    def test_leaked_v4_key_fails(self):
        ctx = self.run_case(self.CLEAN + ['{"type":"pairing_mode_ended","window_id":3}'])
        self.assertTrue(any("v4 wire key" in n for n in ctx.failed()))

    def test_protocol_version_4_fails(self):
        ctx = self.run_case(['pairing_info {"protocol_version":4}', "entering_pairing_mode"])
        self.assertEqual(ctx.failed(), ["pairing_info protocol_version stays 2"])

    def test_no_logged_anchor_is_a_gap_not_a_pass(self):
        ctx = self.run_case([])
        self.assertEqual(ctx.failed(), [])
        self.assertTrue(ctx.gaps)


class HelperTests(unittest.TestCase):
    def test_refused_requires_no_usable_link(self):
        self.assertTrue(cases.refused([{"connected": False}, {"connected": True, "link_seconds": 0.5}]))
        self.assertFalse(cases.refused([{"connected": True, "link_seconds": 9}]))

    def test_owner_state_uses_the_newest_state_line(self):
        ctx = TransferCtx(bes_lines=[h.BES_ENTER_DONE_FORGOT, h.BES_ENTER_DONE])
        self.assertEqual(cases.owner_state(ctx), (1, 1))
        ctx = TransferCtx(bes_lines=[h.BES_ENTER_DONE, h.BES_ENTER_DONE_FORGOT])
        self.assertEqual(cases.owner_state(ctx), (0, 0))

    def test_wire_fact_gaps_when_no_log_carries_it(self):
        ctx = TransferCtx()
        self.assertFalse(cases.wire_fact(ctx, "x", r"window_id"))
        self.assertEqual(ctx.failed(), [])
        self.assertEqual(len(ctx.gaps), 1)

    def test_answer_while_counts_taps(self):
        value, n = cases.answer_while(lambda: (time.sleep(0.3), "ok")[1], lambda: True, interval=0.05)
        self.assertEqual(value, "ok")
        self.assertGreater(n, 0)

    def test_cancel_window_uses_a_triple_press(self):
        ctx = TransferCtx(bes_lines=[h.BES_TOGGLE])
        with mock.patch.object(cases, "pmx", mock.MagicMock()) as pm:
            cases.cancel_window(ctx, 0)
        pm.inject.assert_called_once_with("triple", 50)
        self.assertEqual(ctx.failed(), [])


if __name__ == "__main__":
    unittest.main()
