"""U1 and U3 are BES-only component evidence. No devices."""

import unittest

import upgrade_cases as u

LEGACY = {"mentra": {"secure": False, "pairing": False}}
NEW_ADV = {"mentra": {"secure": True, "pairing": False}}


class U3Tests(unittest.TestCase):
    def test_ownerless_legacy_baseline_passes_when_it_stays_ownerless(self):
        before = {"own": 0, "bes": u.OLD_BES, "adv": LEGACY}
        after = {"own": 0, "bes": "pmx/debug-build-x2", "adv": NEW_ADV, "window": False}
        checks = u.assess_u3(before, after)
        self.assertEqual(u.verdict(checks), "PASS")
        self.assertTrue(any("component-upgrade" in detail for _, _, detail in checks))

    def test_a_window_or_a_new_owner_fails(self):
        before = {"own": 0, "bes": u.OLD_BES, "adv": LEGACY}
        after = {"own": 1, "bes": "new", "adv": {"mentra": {"pairing": True}}, "window": True}
        self.assertEqual(u.verdict(u.assess_u3(before, after)), "FAIL")

    def test_secure_advert_is_not_a_legacy_baseline(self):
        before = {"own": 0, "bes": u.OLD_BES, "adv": {"mentra": {"secure": True, "pairing": False}}}
        after = {"own": 0, "bes": "new", "adv": NEW_ADV, "window": False}
        self.assertEqual(u.verdict(u.assess_u3(before, after)), "FAIL")


class U1Tests(unittest.TestCase):
    def _before(self, **kw):
        base = {"own": 1, "bes": u.OLD_BES, "s22_bond": True, "owner_created_on_old_bes": True, "adv": LEGACY}
        base.update(kw)
        return base

    def _after(self, **kw):
        base = {"own": 1, "bes": "new", "reconnect": True, "card": False, "window": False}
        base.update(kw)
        return base

    def test_owner_kept_without_a_card_passes(self):
        self.assertEqual(u.verdict(u.assess_u1(self._before(), self._after())), "PASS")

    def test_leftover_pr_record_is_not_a_baseline(self):
        before = self._before(owner_created_on_old_bes=False)
        self.assertEqual(u.verdict(u.assess_u1(before, self._after())), "FAIL")

    def test_card_or_lost_owner_fails(self):
        self.assertEqual(u.verdict(u.assess_u1(self._before(), self._after(card=True))), "FAIL")
        self.assertEqual(u.verdict(u.assess_u1(self._before(), self._after(own=0))), "FAIL")


if __name__ == "__main__":
    unittest.main()
