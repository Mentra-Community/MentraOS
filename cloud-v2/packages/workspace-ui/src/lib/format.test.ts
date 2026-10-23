import { describe, expect, test } from "bun:test";
import { formatExpiry } from "./format";

// Local-time dates, so the calendar-day count is the viewer's whatever the machine's zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const NOW = new Date(2026, 9, 15, 16, 40);

describe("when an invitation expires", () => {
  test("counts the viewer's calendar days: Today, Tomorrow, In 6 days", () => {
    expect(formatExpiry(at(15, 23, 59), NOW)).toBe("Today");
    expect(formatExpiry(at(16, 0, 1), NOW)).toBe("Tomorrow");
    expect(formatExpiry(at(16, 23, 59), NOW)).toBe("Tomorrow");
    expect(formatExpiry(at(17, 9), NOW)).toBe("In 2 days");
    expect(formatExpiry(at(21, 16, 40), NOW)).toBe("In 6 days");
  });

  test("an invitation that has expired says so, and a string that is not a date is shown as it came", () => {
    expect(formatExpiry(at(15, 16, 40), NOW)).toBe("Expired");
    expect(formatExpiry(at(14, 9), NOW)).toBe("Expired");
    expect(formatExpiry("soon", NOW)).toBe("soon");
  });
});
