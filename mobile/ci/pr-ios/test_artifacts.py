import datetime as dt
import unittest
from artifacts import BUNDLE_ID, validate_profile


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.profile = {"TeamIdentifier": ["TEAM"], "ExpirationDate": dt.datetime(2027, 1, 1),
                        "ProvisionedDevices": ["iphone", "mac"],
                        "Entitlements": {"get-task-allow": False, "application-identifier": f"TEAM.{BUNDLE_ID}"}}
        self.now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)

    def test_allows_one_profile_for_both_device_types(self):
        self.assertEqual(validate_profile(self.profile, self.now), "TEAM")

    def test_rejects_app_store_enterprise_development_and_expired_profiles(self):
        for change in [{"ProvisionedDevices": []}, {"ProvisionsAllDevices": True},
                       {"ExpirationDate": dt.datetime(2025, 1, 1)},
                       {"Entitlements": {**self.profile["Entitlements"], "get-task-allow": True}},
                       {"Entitlements": {**self.profile["Entitlements"], "application-identifier": "TEAM.other"}}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_profile({**self.profile, **change}, self.now)


if __name__ == "__main__":
    unittest.main()
