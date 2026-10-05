import { expect, test } from "bun:test";
import { AudioTimeline } from "./audioTimeline";

test("provider samples map back to submitted frames despite gaps, loss and session changes", () => {
  const timeline = new AudioTimeline();
  timeline.add(160, { sessionTag: 1, offsetMs: 100 });
  timeline.add(160, { sessionTag: 1, offsetMs: 140 });
  expect(timeline.at(5)).toEqual({ sessionTag: 1, offsetMs: 105 });
  expect(timeline.at(10)).toEqual({ sessionTag: 1, offsetMs: 140 });
  timeline.add(160, { sessionTag: 2, offsetMs: 0 });
  expect(timeline.at(20)).toEqual({ sessionTag: 2, offsetMs: 0 });
  timeline.prune(10);
  expect(timeline.at(0)).toBeUndefined();
  timeline.reset();
  timeline.add(160, { sessionTag: 2, offsetMs: 90 });
  expect(timeline.at(0)).toEqual({ sessionTag: 2, offsetMs: 90 });
});
