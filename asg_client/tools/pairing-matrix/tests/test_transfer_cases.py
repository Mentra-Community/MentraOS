"""Ownership-transfer cases (T0..T9): registration, the MENTRA_TRANSFER switch, skip behavior, and the T0 wire scan.
No device is touched: the cases that would drive hardware stop at require_transfer / not_testable here."""

import os
import re
import time
import types
import unittest
from unittest import mock

from tests import helpers as h
import cases

NEW_IDS = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"]
ON_ONLY = NEW_IDS[1:]


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

    def not_testable(self, why):
        self.untestable = why


def with_mode(value):
    env = {} if value is None else {cases.TRANSFER_ENV: value}
    return mock.patch.dict(os.environ, env if value is not None else {}, clear=False)


class RegistrationTests(unittest.TestCase):
    def test_all_transfer_cases_register_with_docstrings(self):
        for cid in NEW_IDS:
            self.assertIn(cid, cases.CASES)
            self.assertTrue(cases.CASES[cid].__doc__, cid)

    def test_ids_are_unique_in_the_source(self):
        text = open(cases.__file__).read()
        ids = re.findall(r'^@case\("([^"]+)"\)', text, re.M)
        for cid in NEW_IDS:
            self.assertEqual(ids.count(cid), 1, cid)

    def test_t6_docstring_marks_the_product_sign_off(self):
        self.assertIn("PENDING PRODUCT SIGN-OFF", cases.CASES["T6"].__doc__)


class ModeTests(unittest.TestCase):
    def test_default_is_off(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(cases.TRANSFER_ENV, None)
            self.assertEqual(cases.transfer_mode(), "off")
            self.assertFalse(cases.transfer_on())

    def test_on_and_off_are_case_insensitive(self):
        with with_mode(" ON "):
            self.assertEqual(cases.transfer_mode(), "on")
        with with_mode("off"):
            self.assertEqual(cases.transfer_mode(), "off")

    def test_anything_else_is_an_error(self):
        with with_mode("1"), self.assertRaises(ValueError):
            cases.transfer_mode()

    def test_on_cases_are_not_testable_when_off(self):
        for cid in ON_ONLY:
            ctx = TransferCtx()
            with with_mode("off"):
                cases.CASES[cid](ctx)
            self.assertIn("MENTRA_TRANSFER=on", ctx.untestable, cid)
            self.assertEqual(ctx.checks, [], cid)

    def test_t0_is_not_testable_when_on(self):
        ctx = TransferCtx()
        with with_mode("on"):
            cases.CASES["T0"](ctx)
        self.assertIn("MENTRA_TRANSFER=off", ctx.untestable)

    def test_t9_is_documented_unsupported_when_on(self):
        ctx = TransferCtx()
        with with_mode("on"):
            cases.CASES["T9"](ctx)
        self.assertIn("unsupported", ctx.untestable)

    def test_t2_waits_for_the_iphone_spike(self):
        ctx = TransferCtx()
        with with_mode("on"), mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PMX_IOS_SPIKE_B0", None)
            cases.CASES["T2"](ctx)
        self.assertIn("spike B0", ctx.untestable)

    def test_t8_needs_a_staged_legacy_owner(self):
        ctx = TransferCtx()
        with with_mode("on"), mock.patch.object(cases, "own_probe", lambda c: {"own": 0, "classic": 0, "line": "x"}):
            cases.CASES["T8"](ctx)
        self.assertIn("legacy Classic-only", ctx.untestable)


class WireScanTests(unittest.TestCase):
    def leaks(self, **kw):
        return cases.wire_hits(TransferCtx(**kw), cases.TRANSFER_KEY_RX)

    def test_flag_off_json_has_no_transfer_keys(self):
        ph = ['I/Bridge: pairing_info {"secure_pairing_capable":true,"protocol_version":2,"owner_committed":true}',
              "I/Bridge: LIVE: Glasses entering pairing mode — owner lost, no reconnect"]
        self.assertEqual(self.leaks(phone=ph), [])

    def test_each_transfer_key_is_caught_in_any_source(self):
        self.assertTrue(self.leaks(phone=['{"type":"entering_pairing_mode","owner_retained":true}']))
        self.assertTrue(self.leaks(asg=['send {\\"awaiting_confirm\\":false}']))
        self.assertTrue(self.leaks(ios_lines=["PAIRFLOW: ownership_transfer=true"]))

    def test_protocol_version_regex(self):
        line = 'pairing_info {"protocol_version":3}'
        self.assertEqual(cases.PROTOCOL_VERSION_RX.search(line).group(1), "3")


class T0Tests(unittest.TestCase):
    def run_t0(self, phone, bes=None):
        ctx = TransferCtx(bes_lines=bes, phone=phone)
        stub = lambda *a, **k: None  # noqa: E731
        with with_mode("off"), \
                mock.patch.object(cases, "stage_old_owner", stub), \
                mock.patch.object(cases, "run_owner_lost", stub), \
                mock.patch.object(cases, "open_window", stub), \
                mock.patch.object(cases, "time", types.SimpleNamespace(sleep=lambda *_: None, time=time.time)):
            cases.CASES["T0"](ctx)
        return ctx

    CLEAN = ['I/Bridge: pairing_info {"protocol_version":2,"owner_committed":true}',
             "I/Bridge: LIVE: Glasses entering pairing mode — owner lost, no reconnect"]

    def test_clean_logs_pass_with_no_gap(self):
        ctx = self.run_t0(self.CLEAN)
        self.assertEqual(ctx.failed(), [])
        self.assertEqual(ctx.gaps, [])
        self.assertIn("pairing_info protocol_version stays 2", ctx.ok_names())

    def test_leaked_key_fails(self):
        ctx = self.run_t0(self.CLEAN + ['entering_pairing_mode {"owner_retained":false}'])
        self.assertTrue(any("owner_retained" in n for n in ctx.failed()))

    def test_protocol_version_3_fails(self):
        ctx = self.run_t0(['pairing_info {"protocol_version":3}', "entering_pairing_mode"])
        self.assertEqual(ctx.failed(), ["pairing_info protocol_version stays 2"])

    def test_no_logged_anchor_is_a_gap_not_a_pass(self):
        ctx = self.run_t0([])
        self.assertEqual(ctx.failed(), [])
        self.assertTrue(ctx.gaps)


class HelperTests(unittest.TestCase):
    def test_refused_requires_no_usable_link(self):
        self.assertTrue(cases.refused([{"connected": False}, {"connected": True, "link_seconds": 0.5}]))
        self.assertFalse(cases.refused([{"connected": True, "link_seconds": 9}]))

    def test_owner_state_uses_the_newest_state_line(self):
        ctx = TransferCtx(bes_lines=[h.BES_PRE_OWNER, h.BES_ENTER_DONE])
        self.assertEqual(cases.owner_state(ctx), (0, 0))
        ctx = TransferCtx(bes_lines=[h.BES_ENTER_DONE, h.BES_OWN1])
        self.assertEqual(cases.owner_state(ctx), (1, 1))

    def test_wire_fact_gaps_when_no_log_carries_it(self):
        ctx = TransferCtx()
        self.assertFalse(cases.wire_fact(ctx, "x", r"awaiting_confirm"))
        self.assertEqual(ctx.failed(), [])
        self.assertEqual(len(ctx.gaps), 1)

    def test_answer_while_counts_taps(self):
        value, n = cases.answer_while(lambda: (time.sleep(0.3), "ok")[1], lambda: True, interval=0.05)
        self.assertEqual(value, "ok")
        self.assertGreater(n, 0)


if __name__ == "__main__":
    unittest.main()
