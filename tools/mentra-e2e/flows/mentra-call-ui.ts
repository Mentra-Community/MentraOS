import type {Step} from "../runner/suite"

// Qualified fixture: paired Mentra Live, permissions granted, saved name Mentra Live,
// Direct link on, 540p/15 fps/Auto/102° bottom. Read-only preferences; no meeting is created.
// Field editing and connected media remain separate, unqualified coverage.
export const mentraCallUi: Step[] = [
  {
    id: "CALL-UI-01-host",
    instruction: "Verify paired host home is ready to open Mentra Call.",
    expected: "The Call launcher is available and no miniapp is open.",
    checks: [
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
    ],
  },
  {
    id: "CALL-UI-02-open",
    instruction: "Open Mentra Call from home.",
    expected: "Join via Link, New Call and Settings are enabled.",
    action: {
      op: "press",
      selector: {
        identifier: "home.miniapp.com.mentra.call",
      },
    },
    checks: [
      {
        selector: {
          role: "AXButton",
          description: "Join via Link Microsoft Teams",
          enabled: true,
        },
      },
      {
        selector: {
          role: "AXButton",
          description: "New Call Create a meeting.",
          enabled: true,
        },
      },
      {
        selector: {
          role: "AXButton",
          description: "Open settings",
          enabled: true,
        },
      },
    ],
  },
  {
    id: "CALL-UI-03-settings",
    instruction: "Open Call settings and inspect the saved call name.",
    expected: "Settings is open and Name in calls is Mentra Live.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "Open settings",
      },
    },
    checks: [
      {
        selector: {
          role: "AXHeading",
          description: "Settings",
        },
      },
      {
        selector: {
          role: "AXTextField",
          description: "Name in calls How you appear to other participants",
          value: "Mentra Live",
        },
      },
    ],
  },
  {
    id: "CALL-UI-04-preferences",
    instruction: "Verify the configured Direct link and Chat TTS states.",
    expected: "Direct link is on; Chat TTS is off and disabled.",
    checks: [
      {
        selector: {
          role: "AXCheckBox",
          description: "Connect work Teams straight to this phone",
          value: "1",
          enabled: true,
        },
      },
      {
        selector: {
          role: "AXCheckBox",
          description: "Chat TTS is turned off and cannot be changed",
          value: "0",
          enabled: false,
        },
      },
    ],
  },
  {
    id: "CALL-UI-05-video",
    instruction: "Reveal Bitrate using Auto's semantic scroll action.",
    expected: "Auto and the unchanged 960×540, 15 fps, Auto bitrate, 102° bottom profile are visible.",
    action: {
      op: "perform",
      action: "AXScrollToVisible",
      selector: {
        role: "AXRadioButton",
        description: "Auto",
        visible: false,
      },
    },
    checks: [
      {
        selector: {
          role: "AXRadioButton",
          description: "Auto",
        },
      },
      {
        selector: {
          role: "AXStaticText",
          description: "960×540 @ 15 · Auto · 102° bottom",
        },
      },
    ],
  },
  {
    id: "CALL-UI-06-back",
    instruction: "Return from settings to Call home.",
    expected: "Both meeting entry points are enabled.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "Go back",
      },
    },
    checks: [
      {
        selector: {
          role: "AXButton",
          description: "Join via Link Microsoft Teams",
          enabled: true,
        },
      },
      {
        selector: {
          role: "AXButton",
          description: "New Call Create a meeting.",
          enabled: true,
        },
      },
    ],
  },
  {
    id: "CALL-UI-07-join",
    instruction: "Open Join via Link without joining.",
    expected: "The empty link field and disabled Join Meeting action are visible.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "Join via Link Microsoft Teams",
      },
    },
    checks: [
      {
        selector: {
          role: "AXHeading",
          description: "Join Call",
        },
      },
      {
        selector: {
          role: "AXTextField",
          description: "PASTE A TEAMS MEETING LINK",
          value: "teams.microsoft.com/l/meetup-join/…",
        },
      },
      {
        selector: {
          role: "AXButton",
          description: "Join Meeting",
          enabled: false,
        },
      },
    ],
  },
  {
    id: "CALL-UI-08-leave-form",
    instruction: "Leave the empty join form.",
    expected: "Call home returns.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "Go back",
      },
    },
    checks: [
      {
        selector: {
          role: "AXButton",
          description: "New Call Create a meeting.",
          enabled: true,
        },
      },
    ],
  },
  {
    id: "CALL-UI-09-new",
    instruction: "Open New Call without creating a meeting.",
    expected: "The default meeting name is Mentra Call and Create & Join is enabled.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "New Call Create a meeting.",
      },
    },
    checks: [
      {
        selector: {
          role: "AXHeading",
          description: "New Call",
        },
      },
      {
        selector: {
          role: "AXTextField",
          description: "MEETING NAME",
          value: "Mentra Call",
        },
      },
      {
        selector: {
          role: "AXButton",
          description: "Create & Join",
          enabled: true,
        },
      },
    ],
  },
  {
    id: "CALL-UI-10-leave-new",
    instruction: "Return from New Call without submitting it.",
    expected: "Call home returns with no connecting state.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "Go back",
      },
    },
    checks: [
      {
        selector: {
          role: "AXButton",
          description: "Join via Link Microsoft Teams",
          enabled: true,
        },
      },
      {
        selector: {
          role: "AXButton",
          description: "Cancel",
        },
        absent: true,
      },
    ],
  },
  {
    id: "CALL-UI-11-minimize",
    instruction: "Minimize Call using the named capsule button.",
    expected: "Host home returns and the Call home controls disappear.",
    action: {
      op: "press",
      selector: {
        identifier: "miniapp.minimize",
      },
    },
    checks: [
      {
        selector: {
          identifier: "home.miniapp.com.mentra.call",
        },
      },
      {
        selector: {
          identifier: "miniapp.minimize",
        },
        absent: true,
      },
      {
        selector: {
          role: "AXButton",
          description: "Open settings",
        },
        absent: true,
      },
    ],
  },
  {
    id: "CALL-UI-12-reopen",
    instruction: "Reopen Call from the host launcher.",
    expected: "Call home is usable again without another permission prompt.",
    action: {
      op: "press",
      selector: {
        identifier: "home.miniapp.com.mentra.call",
      },
    },
    checks: [
      {
        selector: {
          role: "AXButton",
          description: "Join via Link Microsoft Teams",
          enabled: true,
        },
      },
      {
        selector: {
          role: "AXButton",
          description: "Open settings",
          enabled: true,
        },
      },
    ],
  },
  {
    id: "CALL-UI-13-close",
    instruction: "Close Call using the named capsule control.",
    expected: "The host launcher returns and Call's controls disappear.",
    action: {
      op: "press",
      selector: {
        identifier: "miniapp.close",
      },
    },
    checks: [
      {
        selector: {
          identifier: "home.miniapp.com.mentra.call",
        },
      },
      {
        selector: {
          identifier: "miniapp.close",
        },
        absent: true,
      },
      {
        selector: {
          role: "AXButton",
          description: "Open settings",
        },
        absent: true,
      },
    ],
  },
]
