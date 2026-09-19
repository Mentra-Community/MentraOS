import type {Step} from "../runner/suite"

const call = {identifier: "home.miniapp.com.mentra.call"}
const toggle = {identifier: "debug-show-mentra-call-ios"}
const notify = {identifier: "home.miniapp.cloud.augmentos.notify"}
const notifyToggle = {identifier: "debug-show-notify-ios"}

function home(id: string, visible: boolean, relaunch = false, notifyVisible = false): Step {
  return {
    id,
    instruction: relaunch
      ? "Restart the Mentra App and check Call and Notify availability."
      : "Check Call and Notify availability on home.",
    expected: `Home is ready; Call is ${visible ? "visible" : "hidden"} and Notify is ${notifyVisible ? "visible" : "hidden"}.`,
    ...(relaunch ? {action: {op: "relaunch"}} : {}),
    checks: [
      {selector: {identifier: "home.allApps.open"}},
      {selector: {identifier: "miniapp.close"}, absent: true},
      {selector: call, ...(visible ? {count: 1} : {absent: true})},
      {selector: notify, ...(notifyVisible ? {count: 1} : {absent: true})},
    ],
    timeoutMs: 30000,
    stableForMs: 1000,
  }
}

function openDebug(prefix: string, value: "0" | "1", buildOverride = false, notifyValue: "0" | "1" = "0"): Step[] {
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
      instruction: "Open Debug Settings and inspect the Call and Notify switches.",
      expected: buildOverride
        ? "Call is enabled by the build override; its switch is on and disabled. Notify remains off and editable."
        : `Call is ${value === "1" ? "on" : "off"}; Notify is ${notifyValue === "1" ? "on" : "off"}. Both switches are editable.`,
      action: {op: "press", selector: {role: "AXGenericElement", contains: "Debug settings"}},
      checks: [
        {selector: {...toggle, value, enabled: !buildOverride}, count: 1},
        {selector: {...notifyToggle, value: notifyValue, enabled: true}, count: 1},
        {selector: notifyToggle, action: "AXPress"},
        ...(buildOverride
          ? [{selector: {contains: "Enabled by this build's EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS override."}}]
          : [{selector: toggle, action: "AXPress"}]),
      ],
    },
  ]
}

function closeDebug(id: string, visible: boolean, notifyVisible = false): Step {
  return {
    ...home(id, visible, false, notifyVisible),
    instruction: "Close Settings and check both launchers.",
    action: {op: "press", selector: {identifier: "miniapp.close"}},
  }
}

function searchHidden(prefix: string, name: "Call" | "Notify" = "Call"): Step[] {
  const packageName = name === "Call" ? "com.mentra.call" : "cloud.augmentos.notify"
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
      instruction: `Search All Apps for ${name}.`,
      expected: `The search reads ${name} and its miniapp is absent, including previously installed entries.`,
      action: {op: "type", method: "ax-value", selector: {identifier: "home.allApps.search"}, text: name},
      stableForMs: 1000,
      checks: [
        {selector: {identifier: "home.allApps.search", value: name}},
        {selector: {identifier: `allApps.miniapp.${packageName}`}, absent: true},
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
      expected: "Home is restored with Call and Notify hidden.",
      action: {op: "press", selector: {identifier: "home.allApps.close"}},
      checks: [
        {selector: {identifier: "home.allApps.close"}, absent: true},
        {selector: call, absent: true},
        {selector: notify, absent: true},
      ],
    },
  ]
}

/** Default build, English paired home, Debug Mode unlocked, both miniapp switches off. */
export const iosCallVisibility: Step[] = [
  home("VIS-01-default", false),
  ...searchHidden("VIS-02-default-search"),
  ...searchHidden("VIS-02-default-notify-search", "Notify"),
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
  ...openDebug("VIS-06-enable-notify", "1"),
  {
    id: "VIS-06-notify-on",
    instruction: "Turn on Show Notify (experimental) while Call remains enabled.",
    expected: "Both switches are on.",
    action: {op: "press", selector: notifyToggle},
    checks: [{selector: {...notifyToggle, value: "1"}}, {selector: {...toggle, value: "1"}}],
  },
  closeDebug("VIS-06-both-home", true, true),
  home("VIS-06-both-restart", true, true, true),
  ...openDebug("VIS-07-disable", "1", false, "1"),
  {
    id: "VIS-08-disable",
    instruction: "Turn off Show Mentra Call (experimental).",
    expected: "The switch is off.",
    action: {op: "press", selector: toggle},
    checks: [{selector: {...toggle, value: "0"}}],
  },
  closeDebug("VIS-09-notify-only-home", false, true),
  home("VIS-09-notify-only-restart", false, true, true),
  ...openDebug("VIS-09-disable-notify", "0", false, "1"),
  {
    id: "VIS-09-notify-off",
    instruction: "Turn off Show Notify (experimental).",
    expected: "Both switches are off.",
    action: {op: "press", selector: notifyToggle},
    checks: [{selector: {...notifyToggle, value: "0"}}, {selector: {...toggle, value: "0"}}],
  },
  closeDebug("VIS-09-disabled-home", false),
  home("VIS-10-disabled-restart", false, true),
  ...searchHidden("VIS-11-disabled-search"),
  ...searchHidden("VIS-11-disabled-notify-search", "Notify"),
]

/** Build with EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS=true, saved both miniapp switches off. */
export const iosCallBuildOverride: Step[] = [
  home("ENV-01-visible", true),
  ...openDebug("ENV-02-override", "1", true),
  closeDebug("ENV-03-home", true),
]
