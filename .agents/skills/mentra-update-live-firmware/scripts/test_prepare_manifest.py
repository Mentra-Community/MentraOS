"""Exercise production transitions and component isolation without network writes."""

from copy import deepcopy
import unittest

from prepare_manifest import prepare

A, B, C, D = ["MentraLive_" + v for v in ("20260101", "20260201", "20260301.0", "20260401.0")]


def full(target):
    return {"end_firmware": target, "url": f"https://example.com/{target}.zip",
            "sha256": "a" * 64, "size": 500}


def patch(start, end):
    return {"start_firmware": start, **full(end)}


def feed(start, end):
    return {"target_firmware": end, "mtk_full_ota": full(end),
            "mtk_patches": [patch(start, end)], "mtk_downgrade_patches": [patch(end, start)]}


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.prod = {"mtk_patches": [patch(A, B)]}
        self.current = {"mtk_patches": [patch(B, C), patch(A, B)],
                        "mtk_full_ota": full(C), "bes_firmware": {"version": "1.1.1.1"},
                        "unrelated": {"preserve": True}}

    def test_replace_existing_development_bridge_and_repeat(self):
        original = deepcopy(self.current)
        result = prepare(self.current, self.prod, feed(B, D))
        self.assertEqual(result["mtk_patches"], [patch(B, D), patch(A, B)])
        self.assertEqual(result["mtk_full_ota"], full(D))
        self.assertEqual(result["bes_firmware"], self.current["bes_firmware"])
        self.assertEqual(result["unrelated"], self.current["unrelated"])
        self.assertNotIn("mtk_downgrade_patches", result)
        self.assertEqual(prepare(result, self.prod, feed(B, D)), result)
        self.assertEqual(self.current, original)

    def test_add_first_bridge(self):
        result = prepare(self.prod, self.prod, feed(B, C))
        self.assertEqual(result["mtk_patches"], [patch(B, C), patch(A, B)])

    def test_after_production_release_advance_baseline_and_keep_history(self):
        production = deepcopy(self.current)
        result = prepare(self.current, production, feed(C, D))
        self.assertEqual(result["mtk_patches"], [patch(C, D), patch(B, C), patch(A, B)])
        self.assertEqual(production, self.current)

    def test_equal_latest_and_production_needs_no_bridge(self):
        mtk = {"mtk_full_ota": full(C), "mtk_patches": []}
        self.assertEqual(prepare(self.current, self.current, mtk), self.current)

    def test_missing_or_ambiguous_feed_patch(self):
        for entries in ([], [patch(B, D), patch(B, D)], [patch(C, D)]):
            mtk = feed(B, D)
            mtk["mtk_patches"] = entries
            with self.subTest(entries=entries), self.assertRaisesRegex(ValueError, "exactly one"):
                prepare(self.current, self.prod, mtk)

    def test_duplicate_source_and_altered_history_rejected(self):
        duplicate = deepcopy(self.current)
        duplicate["mtk_patches"].append(patch(B, D))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            prepare(duplicate, self.prod, feed(B, D))
        changed = deepcopy(self.current)
        changed["mtk_patches"][1]["sha256"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "Released production patch"):
            prepare(changed, self.prod, feed(B, D))

    def test_ambiguous_production_and_conflicting_full_target(self):
        for production in ({"mtk_patches": []},
                           {"mtk_patches": [patch(A, B), patch(C, D)]},
                           {"mtk_patches": [patch(A, B)], "mtk_full_ota": full(C)}):
            with self.subTest(production=production), self.assertRaises(ValueError):
                prepare(self.current, production, feed(B, D))

    def test_regression_and_disconnected_path_rejected(self):
        with self.assertRaisesRegex(ValueError, "regresses"):
            prepare(self.current, self.prod, feed(A, B))
        current = deepcopy(self.current)
        current["mtk_patches"].append(patch("MentraLive_20260115", "MentraLive_20260120"))
        with self.assertRaisesRegex(ValueError, "ends at"):
            prepare(current, self.prod, feed(B, D))

    def test_bes_only_preserves_mtk_and_destination_shape(self):
        bes = {"version": "26.9.15.0", "url": "https://example.com/bes.bin",
               "sha256": "c" * 64, "size": 123}
        result = prepare(self.current, bes=bes)
        self.assertEqual(result["mtk_patches"], self.current["mtk_patches"])
        self.assertEqual(result["mtk_full_ota"], self.current["mtk_full_ota"])
        self.assertNotIn("size", result["bes_firmware"])
        self.current["bes_firmware"]["size"] = 100
        self.assertEqual(prepare(self.current, bes=bes)["bes_firmware"]["size"], 123)


if __name__ == "__main__":
    unittest.main()
