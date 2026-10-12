import {expect, test} from "bun:test";
import {elapsedDuration, runDuration} from "./run-duration";

test("durations round up to whole seconds and omit zero minutes and pad seconds after minutes", () => {
  for (const [ms, expected] of [[0, "0s"], [1, "1s"], [45000, "45s"], [187000, "3m 07s"], [59999, "1m 00s"],
    [60000, "1m 00s"], [60001, "1m 01s"], [304500, "5m 05s"], [3599000, "59m 59s"]] as const) {
    expect(elapsedDuration(ms)).toBe(expected);
  }
});

test("hour durations carry rounded seconds and pad remaining minutes and seconds", () => {
  for (const [ms, expected] of [[3599001, "1h 00m 00s"], [3599999, "1h 00m 00s"], [3600000, "1h 00m 00s"],
    [3600001, "1h 00m 01s"], [3723000, "1h 02m 03s"], [7199001, "2h 00m 00s"],
    [90000000, "25h 00m 00s"]] as const) {
    expect(elapsedDuration(ms)).toBe(expected);
  }
  expect(runDuration("2026-10-06T11:00:00Z", "2026-10-06T12:02:02.500Z")).toBe("1h 02m 03s");
});

test("missing, invalid or negative durations remain unknown", () => {
  for (const value of [undefined, null, "1000", NaN, Infinity, -Infinity, -1]) expect(elapsedDuration(value)).toBeNull();
  expect(runDuration(undefined, "2026-10-06T11:00:00Z")).toBeNull();
  expect(runDuration("2026-10-06T11:00:00Z", null)).toBeNull();
  expect(runDuration("bad", "2026-10-06T11:00:00Z")).toBeNull();
  expect(runDuration("2026-10-06T11:00:00Z", "bad")).toBeNull();
  expect(runDuration("2026-10-06T11:00:01Z", "2026-10-06T11:00:00Z")).toBeNull();
  expect(runDuration("2026-10-06T11:00:00Z", "2026-10-06T11:05:04.500Z")).toBe("5m 05s");
});
