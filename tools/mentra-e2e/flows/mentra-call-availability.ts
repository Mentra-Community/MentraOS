import type {Step} from "../runner/suite"

// Host availability only. This does not exercise the Call WebView or a meeting.
export const mentraCallAvailability: Step[] = [
  {
    id: "CALL-HOST-01-home",
    instruction: "Verify signed-in home and the Mentra Call launcher.",
    expected: "Exactly one Call launcher and All Apps are available; no miniapp or All Apps sheet is open.",
    checks: [
      {
        selector: {
          identifier: "home.allApps.open",
        },
        action: "AXPress",
      },
      {
        selector: {
          identifier: "home.miniapp.com.mentra.call",
        },
        count: 1,
        action: "AXPress",
      },
      {
        selector: {
          identifier: "miniapp.close",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "home.allApps.close",
        },
        absent: true,
      },
    ],
  },
  {
    id: "CALL-HOST-02-open",
    instruction: "Open All Apps from home.",
    expected: "The miniapp search field and named Close button are available.",
    action: {
      op: "press",
      selector: {
        identifier: "home.allApps.open",
      },
    },
    checks: [
      {
        selector: {
          identifier: "home.allApps.search",
        },
        count: 1,
      },
      {
        selector: {
          identifier: "home.allApps.close",
        },
        action: "AXPress",
      },
    ],
  },
  {
    id: "CALL-HOST-03-search",
    instruction: "Search All Apps for Call.",
    expected: "The search reads Call and shows exactly one miniapp result: Mentra Call.",
    action: {
      op: "type",
      method: "ax-value",
      selector: {
        identifier: "home.allApps.search",
      },
      text: "Call",
    },
    checks: [
      {
        selector: {
          identifier: "home.allApps.search",
          value: "Call",
        },
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.call",
        },
        count: 1,
        action: "AXPress",
      },
      {
        selector: {
          identifierPrefix: "allApps.miniapp.",
        },
        count: 1,
      },
      {
        selector: {
          identifier: "home.allApps.clearSearch",
        },
        action: "AXPress",
      },
    ],
  },
  {
    id: "CALL-HOST-04-clear",
    instruction: "Clear the Call search using its named control.",
    expected: "The query is empty; Settings and Mentra Call are both listed.",
    action: {
      op: "press",
      selector: {
        identifier: "home.allApps.clearSearch",
      },
    },
    checks: [
      {
        selector: {
          identifier: "home.allApps.search",
          value: "",
        },
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.settings",
        },
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.call",
        },
        count: 1,
      },
      {
        selector: {
          identifier: "home.allApps.clearSearch",
        },
        absent: true,
      },
    ],
  },
  {
    id: "CALL-HOST-05-home",
    instruction: "Close All Apps and restore the Mentra App home page.",
    expected: "The search and sheet disappear; home and its Call launcher return with no foreground miniapp.",
    action: {
      op: "press",
      selector: {
        identifier: "home.allApps.close",
      },
    },
    checks: [
      {
        selector: {
          identifier: "home.allApps.search",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "home.allApps.close",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "home.allApps.open",
        },
        count: 1,
      },
      {
        selector: {
          identifier: "home.miniapp.com.mentra.call",
        },
        count: 1,
      },
      {
        selector: {
          identifier: "miniapp.close",
        },
        absent: true,
      },
    ],
  },
]
