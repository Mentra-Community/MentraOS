import unittest

import support  # noqa: F401 - sets sys.path
from blespeed.results import PhotoRow
from blespeed.stats import (
    Distribution,
    cell_stats,
    least_squares_slope,
    leg_verdicts,
    percentile_nearest_rank,
    speed_floor,
)


def row(phone="p1", condition="A", size="medium", e2e=80.0, outcome="finished", warmup=False,
        payload=204800, uart=87.0, drain=150, busy=0, transfer_retries=0, phone_os="android"):
    confirm = None if e2e is None else int(round(payload / 1024.0 / e2e * 1000))
    return PhotoRow(run_id="r", phone=phone, phone_os=phone_os, condition=condition, size=size,
                    index=1, warmup=warmup, request_id="rid", ble_img_id="I000000001",
                    outcome=outcome, busy_retries=busy, transfer_retries=transfer_retries,
                    payload_bytes=payload, transfer_speed_kbps=uart, phone_confirm_ms=confirm,
                    last_packet_to_phone_ack_ms=drain, e2e_kbps=e2e)


class PercentileTest(unittest.TestCase):
    def test_nearest_rank_by_hand(self):
        values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
        self.assertEqual(10, percentile_nearest_rank(values, 10))   # ceil(1.0) = 1st
        self.assertEqual(20, percentile_nearest_rank(values + [110], 10))  # ceil(1.1) = 2nd
        self.assertEqual(50, percentile_nearest_rank(values, 50))
        self.assertEqual(100, percentile_nearest_rank(values, 100))

    def test_twenty_values(self):
        values = list(range(1, 21))
        self.assertEqual(2, percentile_nearest_rank(values, 10))  # ceil(2.0) = 2nd

    def test_n_equals_one_and_ties(self):
        self.assertEqual(42, percentile_nearest_rank([42], 10))
        self.assertEqual(5, percentile_nearest_rank([5, 5, 5, 9], 10))

    def test_unsorted_input(self):
        self.assertEqual(1, percentile_nearest_rank([9, 3, 1, 7], 10))

    def test_invalid(self):
        with self.assertRaises(ValueError):
            percentile_nearest_rank([], 10)
        with self.assertRaises(ValueError):
            percentile_nearest_rank([1], 0)

    def test_distribution(self):
        dist = Distribution.of([4.0, 1.0, 3.0, 2.0])
        self.assertEqual((4, 2.5, 1.0, 1.0, 4.0),
                         (dist.n, dist.median, dist.p10, dist.minimum, dist.maximum))
        self.assertIsNone(Distribution.of([]))


class CellStatsTest(unittest.TestCase):
    def test_failures_excluded_from_speed_but_counted(self):
        rows = [row(e2e=80), row(e2e=90), row(e2e=None, outcome="timeout"),
                row(e2e=100, warmup=True), row(e2e=70, busy=1)]
        [cell] = cell_stats(rows)
        self.assertEqual(4, cell.attempted)
        self.assertEqual(3, cell.succeeded)
        self.assertEqual(1, cell.failed)
        self.assertEqual(1, cell.retried)
        self.assertEqual(80, cell.e2e.median)
        self.assertEqual(70, cell.e2e.p10)
        self.assertAlmostEqual(0.25, cell.failure_rate)
        self.assertAlmostEqual(200.0, cell.mean_payload_kb)

    def test_finished_row_without_e2e_is_not_ok(self):
        [cell] = cell_stats([row(e2e=80), row(e2e=None)])
        self.assertEqual(1, cell.succeeded)
        self.assertEqual(1, cell.failed)

    def test_flag_boundary(self):
        exactly_5 = [row() for _ in range(19)] + [row(e2e=None, outcome="failed")]
        [cell] = cell_stats(exactly_5)
        self.assertAlmostEqual(0.05, cell.failure_rate)
        self.assertFalse(cell.flagged)
        above = [row() for _ in range(18)] + [row(e2e=None, outcome="failed")] * 2
        [cell] = cell_stats(above)
        self.assertTrue(cell.flagged)

    def test_grouping_keeps_first_seen_order(self):
        rows = [row(phone="b"), row(phone="a"), row(phone="b", size="max"), row(phone="a", condition="D")]
        keys = [(c.phone, c.condition, c.size) for c in cell_stats(rows)]
        self.assertEqual([("b", "A", "medium"), ("a", "A", "medium"), ("b", "A", "max"),
                          ("a", "D", "medium")], keys)


class FloorTest(unittest.TestCase):
    def test_rounding_example(self):
        # p10 of 63.9 -> 63.9 * 0.8 = 51.12 -> 50
        result = speed_floor([row(e2e=63.9)] + [row(e2e=90) for _ in range(9)])
        self.assertEqual(50, result.floor_kbps)
        self.assertEqual("p1", result.limiting_phone)

    def test_exact_multiple_does_not_drop_a_step(self):
        self.assertEqual(50, speed_floor([row(e2e=62.5)]).floor_kbps)  # 62.5 * 0.8 = 50.0

    def test_min_phone_wins_and_d_is_excluded(self):
        rows = ([row(phone="ios1", e2e=v) for v in (70, 72, 75)]
                + [row(phone="and1", e2e=v) for v in (80, 85, 90)]
                + [row(phone="and1", condition="D", e2e=10)])
        result = speed_floor(rows)
        self.assertEqual("ios1", result.limiting_phone)
        self.assertEqual({"ios1": 70, "and1": 80}, result.per_phone_p10)
        self.assertEqual(55, result.floor_kbps)  # 70 * 0.8 = 56 -> 55
        self.assertEqual(("A", "B", "C"), result.conditions)

    def test_condition_b_inclusion_toggle(self):
        rows = [row(phone="ios1", condition="A", e2e=80), row(phone="ios1", condition="B", e2e=40)]
        self.assertEqual(30, speed_floor(rows).floor_kbps)  # 40 * 0.8 = 32 -> 30
        excluded = speed_floor(rows, exclude_b=True)
        self.assertEqual(60, excluded.floor_kbps)  # 80 * 0.8 = 64 -> 60
        self.assertEqual(("A", "C"), excluded.conditions)

    def test_failures_and_warmups_ignored(self):
        rows = [row(e2e=80), row(e2e=5, warmup=True), row(e2e=None, outcome="timeout")]
        self.assertEqual(60, speed_floor(rows).floor_kbps)

    def test_no_data(self):
        result = speed_floor([row(e2e=None, outcome="failed")])
        self.assertIsNone(result.floor_kbps)
        self.assertIsNone(result.limiting_phone)

    def test_custom_margin_and_step(self):
        self.assertEqual(72, speed_floor([row(e2e=80)], margin=0.9, step=1).floor_kbps)


class LegVerdictTest(unittest.TestCase):
    def _phone(self, phone, drain_per_kb, base_drain=100, uart=87.0):
        rows = []
        for kb in (100, 150, 200, 250, 300, 350):
            rows.append(row(phone=phone, payload=kb * 1024, drain=int(base_drain + drain_per_kb * kb),
                            uart=uart))
        return rows

    def test_slope(self):
        self.assertAlmostEqual(2.0, least_squares_slope([1, 2, 3], [2, 4, 6]))
        self.assertIsNone(least_squares_slope([1, 1], [2, 3]))
        self.assertIsNone(least_squares_slope([1], [2]))

    def test_growing_drain_is_radio_limited_flat_is_serial(self):
        verdicts = {v.phone: v for v in leg_verdicts(
            self._phone("iphone", drain_per_kb=6) + self._phone("pixel", drain_per_kb=0))}
        self.assertEqual("radio_limited", verdicts["iphone"].verdict)
        self.assertAlmostEqual(6.0, verdicts["iphone"].drain_slope_ms_per_kb, places=1)
        self.assertTrue(verdicts["iphone"].uart_matches_others)
        self.assertEqual("serial_limited", verdicts["pixel"].verdict)

    def test_growing_drain_with_mismatched_uart_is_mixed(self):
        verdicts = {v.phone: v for v in leg_verdicts(
            self._phone("a", drain_per_kb=6, uart=40.0) + self._phone("b", drain_per_kb=0)
            + self._phone("c", drain_per_kb=0))}
        self.assertEqual("mixed", verdicts["a"].verdict)
        self.assertFalse(verdicts["a"].uart_matches_others)

    def test_too_few_points(self):
        [verdict] = leg_verdicts(self._phone("a", 6)[:4])
        self.assertEqual("insufficient_data", verdict.verdict)

    def test_loaded_condition_is_excluded_by_default(self):
        loaded = [row(phone="a", condition="D", payload=200 * 1024, drain=50) for _ in range(5)]
        [verdict] = leg_verdicts(self._phone("a", 6) + loaded)
        self.assertAlmostEqual(6.0, verdict.drain_slope_ms_per_kb, places=1)
        [pooled] = leg_verdicts(self._phone("a", 6) + loaded, conditions=None)
        self.assertGreater(abs(pooled.drain_slope_ms_per_kb - 6.0), 1.0)

    def test_missing_drain_values_are_skipped(self):
        rows = self._phone("a", 6) + [row(phone="a", drain=None) for _ in range(3)]
        [verdict] = leg_verdicts(rows)
        self.assertEqual("radio_limited", verdict.verdict)


if __name__ == "__main__":
    unittest.main()
