import type {Step} from "../runner/suite"

const call = {identifier: "home.miniapp.com.mentra.call"}
const toggle = {identifier: "debug-show-mentra-call-ios"}

function home(id: string, visible: boolean, relaunch = false): Step {
  return {
    id,
    instruction: relaunch ? "Restart the Mentra App and check Call availability." : "Check Call availability on home.",
    expected: `Home is ready and Mentra Call is ${visible ? "visible" : "hidden"}.`,
    ...(relaunch ? {action: {op: "relaunch"}} : {}),
    checks: [
      {selector: {identifier: "home.allApps.open"}},
      {selector: {identifier: "miniapp.close"}, absent: true},
      {selector: call, ...(visible ? {count: 1} : {absent: true})},
    ],
    timeoutMs: 30000,
    stableForMs: 1000,
  }
}

function openDebug(prefix: string, value: "0" | "1", buildOverride = false): Step[] {
  return [
    {
      id: `${prefix}-settings`,
      instruction: "Open Settings from home.",
      expected: "Account settings and Profile are visible.",
      action: {op: "press", selector: {identifier: "home.miniapp.com.mentra.settings"}},
      checks: [
        {selector: {description: "Account settings"}},
        {selector: {role: "AXGenericElement", contains: "Profile"}},
      ],
    },
    {
      id: `${prefix}-scroll`,
      instruction: "Scroll Settings down to the advanced settings section.",
      expected: "Debug settings is available.",
      action: {op: "perform", selector: {role: "AXGenericElement", contains: "Profile"}, action: "AXScrollDownByPage"},
      checks: [{selector: {role: "AXGenericElement", contains: "Debug settings"}}],
    },
    {
      id: `${prefix}-debug`,
      instruction: "Open Debug Settings and inspect the Mentra Call switch.",
      expected: buildOverride
        ? "Call is enabled by the build override; the switch is on and disabled."
        : `The Call debug switch is ${value === "1" ? "on" : "off"} and editable.`,
      action: {op: "press", selector: {role: "AXGenericElement", contains: "Debug settings"}},
      checks: [
        {selector: {...toggle, value, enabled: !buildOverride}, count: 1},
        ...(buildOverride
          ? [{selector: {contains: "Enabled by this build's EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS override."}}]
          : [{selector: toggle, action: "AXPress"}]),
      ],
    },
  ]
}

function closeDebug(id: string, visible: boolean): Step {
  return {
    ...home(id, visible),
    instruction: "Close Settings and check the Call launcher.",
    action: {op: "press", selector: {identifier: "miniapp.close"}},
  }
}

function searchHidden(prefix: string): Step[] {
  return [
    {
      id: `${prefix}-open`,
      instruction: "Open All Apps.",
      expected: "The miniapp search field is available.",
      action: {op: "press", selector: {identifier: "home.allApps.open"}},
      checks: [{selector: {identifier: "home.allApps.search"}}],
    },
    {
      id: `${prefix}-search`,
      instruction: "Search All Apps for Call.",
      expected: "The search reads Call and Mentra Call is absent, including previously installed entries.",
      action: {op: "type", method: "ax-value", selector: {identifier: "home.allApps.search"}, text: "Call"},
      stableForMs: 1000,
      checks: [
        {selector: {identifier: "home.allApps.search", value: "Call"}},
        {selector: {identifier: "allApps.miniapp.com.mentra.call"}, absent: true},
      ],
    },
    {
      id: `${prefix}-clear`,
      instruction: "Clear the miniapp search.",
      expected: "The search field is empty.",
      action: {op: "press", selector: {identifier: "home.allApps.clearSearch"}},
      checks: [{selector: {identifier: "home.allApps.search", value: ""}}],
    },
    {
      id: `${prefix}-close`,
      instruction: "Close All Apps.",
      expected: "Home is restored without Mentra Call.",
      action: {op: "press", selector: {identifier: "home.allApps.close"}},
      checks: [
        {selector: {identifier: "home.allApps.close"}, absent: true},
        {selector: call, absent: true},
      ],
    },
  ]
}

/** Default build, English paired home, Debug Mode unlocked, Call switch off. */
export const iosCallVisibility: Step[] = [
  home("VIS-01-default", false),
  ...searchHidden("VIS-02-default-search"),
  ...openDebug("VIS-03-enable", "0"),
  {
    id: "VIS-04-enable",
    instruction: "Turn on Show Mentra Call (experimental).",
    expected: "The switch is on.",
    action: {op: "press", selector: toggle},
    checks: [{selector: {...toggle, value: "1"}}],
  },
  closeDebug("VIS-05-enabled-home", true),
  home("VIS-06-enabled-restart", true, true),
  ...openDebug("VIS-07-disable", "1"),
  {
    id: "VIS-08-disable",
    instruction: "Turn off Show Mentra Call (experimental).",
    expected: "The switch is off.",
    action: {op: "press", selector: toggle},
    checks: [{selector: {...toggle, value: "0"}}],
  },
  closeDebug("VIS-09-disabled-home", false),
  home("VIS-10-disabled-restart", false, true),
  ...searchHidden("VIS-11-disabled-search"),
]

/** Build with EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS=true, saved Call switch off. */
export const iosCallBuildOverride: Step[] = [
  home("ENV-01-visible", true),
  ...openDebug("ENV-02-override", "1", true),
  closeDebug("ENV-03-home", true),
]
