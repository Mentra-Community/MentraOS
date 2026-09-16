import type {Step} from "../runner/suite"

// Host availability only. This does not exercise the Call WebView or a meeting.
export const mentraCallIosAvailability: Step[] = [
  {
    id: "CALL-IOS-01-home",
    instruction: "Verify signed-in unpaired home and the absence of the Mentra Call launcher.",
    expected: "Pair glasses and All Apps are available; no Call launcher or miniapp is open.",
    checks: [
      {
        selector: {
          role: "AXButton",
          description: "Pair glasses",
        },
      },
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
        absent: true,
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
    id: "CALL-IOS-02-open",
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
    id: "CALL-IOS-03-search",
    instruction: "Search All Apps for Call.",
    expected: "The search reads Call and shows no Call entry or other miniapp results under the current iOS policy.",
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
        absent: true,
      },
      {
        selector: {
          identifierPrefix: "allApps.miniapp.",
        },
        absent: true,
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
    id: "CALL-IOS-04-clear",
    instruction: "Clear the Call search using its named control.",
    expected: "The query is empty and the Settings result returns; Call remains excluded.",
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
        absent: true,
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
    id: "CALL-IOS-05-home",
    instruction: "Close All Apps and restore the Mentra App home page.",
    expected: "The search and sheet disappear; signed-in unpaired home returns with no foreground miniapp.",
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
          role: "AXButton",
          description: "Pair glasses",
        },
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
