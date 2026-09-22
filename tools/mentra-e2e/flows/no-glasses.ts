import type {Step} from "../runner/suite"
import {login} from "./login"
import {onboarding} from "./onboarding"

// Compiled from recorded accessibility discovery. Credentials are supplied at runtime.
const observed: Step[] = [
  {
    id: "PRE-01",
    instruction: "Verify the English, signed-in, unpaired home fixture.",
    expected: "Pair glasses, Settings, and all-miniapps navigation are available; no miniapp or dialog is open.",
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
      },
      {
        selector: {
          identifier: "miniapp.close",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "home.runningApps.close",
        },
        absent: true,
      },
      {
        selector: {
          description: "Glasses Required",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "home.miniapp.com.mentra.settings",
        },
      },
    ],
  },
  {
    id: "HOME-02-open",
    instruction: "Open the all-miniapps sheet from home.",
    expected: "The search field is exposed as an editable field and the close control is named.",
    action: {
      op: "press",
      selector: {
        identifier: "home.allApps.open",
      },
    },
    checks: [
      {selector: {identifier: "allApps.miniapp.com.mentra.call"}, absent: true},
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
        count: 1,
      },
    ],
  },
  {
    id: "HOME-02-scroll-down",
    instruction: "Scroll the all-miniapps list down by one page.",
    expected: "The list remains open and its final Translation entry is accessible.",
    action: {
      op: "perform",
      selector: {
        identifier: "allApps.miniapp.com.mentra.settings",
      },
      action: "AXScrollDownByPage",
    },
    checks: [
      {
        selector: {
          identifier: "home.allApps.search",
        },
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.translation",
        },
      },
    ],
  },
  {
    id: "HOME-02-scroll-up",
    instruction: "Scroll the all-miniapps list back to its beginning.",
    expected: "Captions, Gallery and the search field are available.",
    action: {
      op: "perform",
      selector: {
        identifier: "allApps.miniapp.com.mentra.translation",
      },
      action: "AXScrollUpByPage",
    },
    checks: [
      {
        selector: {
          identifier: "home.allApps.search",
        },
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.captions",
        },
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.camera",
        },
      },
    ],
  },
  {
    id: "HOME-03-search",
    instruction: "Search the all-miniapps sheet for Settings.",
    expected: "Settings is the only matching miniapp; Gallery and Captions are filtered out.",
    action: {
      op: "type",
      method: "ax-value",
      selector: {
        identifier: "home.allApps.search",
      },
      text: "Settings",
    },
    checks: [
      {
        selector: {
          identifier: "home.allApps.search",
          value: "Settings",
        },
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.settings",
        },
        count: 1,
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.camera",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.captions",
        },
        absent: true,
      },
    ],
  },
  {
    id: "HOME-04-empty",
    instruction: "Search for the fixed nonsense query zz-e2e-no-miniapp-9147.",
    expected: "The query remains visible and there are no matching Settings, Gallery or Captions entries.",
    action: {
      op: "type",
      method: "ax-value",
      selector: {
        identifier: "home.allApps.search",
      },
      text: "zz-e2e-no-miniapp-9147",
    },
    checks: [
      {
        selector: {
          identifier: "home.allApps.search",
          value: "zz-e2e-no-miniapp-9147",
        },
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.settings",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.camera",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.captions",
        },
        absent: true,
      },
      {
        selector: {
          identifierPrefix: "allApps.miniapp.",
        },
        absent: true,
      },
    ],
  },
  {
    id: "HOME-05-close",
    instruction: "Close the all-miniapps sheet using its named accessibility control.",
    expected: "The sheet and search field disappear; home returns without opening another miniapp.",
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
          description: "Glasses Required",
        },
        absent: true,
      },
    ],
  },
  {
    id: "HOME-05-reopen",
    instruction: "Reopen all miniapps and check whether the previous search was retained.",
    expected: "The sheet reopens with the previously entered query unchanged.",
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
          value: "zz-e2e-no-miniapp-9147",
        },
        count: 1,
      },
    ],
  },
  {
    id: "HOME-04-clear",
    instruction: "Clear the search using the named Clear Search control.",
    expected: "The search field becomes empty and Settings and Gallery return.",
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
          identifier: "home.allApps.clearSearch",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.settings",
        },
      },
      {
        selector: {
          identifier: "allApps.miniapp.com.mentra.camera",
        },
      },
    ],
  },
  {
    id: "HOME-06-from-list",
    instruction: "Open Settings from the all-miniapps list.",
    expected: "Settings opens with its capsule controls and the all-miniapps sheet closes.",
    action: {
      op: "press",
      selector: {
        identifier: "allApps.miniapp.com.mentra.settings",
      },
    },
    checks: [
      {
        selector: {
          description: "Account settings",
        },
      },
      {
        selector: {
          identifier: "miniapp.minimize",
        },
        count: 1,
      },
      {
        selector: {
          identifier: "home.allApps.search",
        },
        absent: true,
      },
      {
        selector: {
          role: "AXGenericElement",
          contains: "Profile",
        },
      },
      {
        selector: {
          role: "AXGenericElement",
          contains: "Feedback",
        },
      },
      {
        selector: {
          role: "AXGenericElement",
          contains: "Speech",
        },
      },
      {
        selector: {
          role: "AXGenericElement",
          contains: "Privacy",
        },
      },
      {
        selector: {
          role: "AXGenericElement",
          contains: "Miniapp Developer Settings",
        },
      },
      {
        selector: {
          contains: "Appearance",
        },
        absent: true,
      },
    ],
  },
  {
    id: "SET-02-profile",
    instruction: "Open Profile in Settings and verify the designated test account.",
    expected: "Profile Settings shows the test email and account actions.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Profile",
      },
    },
    checks: [
      {
        selector: {
          description: "Profile Settings",
        },
      },
      {
        selector: {
          contains: "__ACCOUNT_EMAIL__",
        },
      },
      {
        selector: {
          identifier: "navigation.back",
        },
        count: 1,
      },
      {
        selector: {
          contains: "Change Password",
        },
      },
    ],
  },
  {
    id: "SET-03-open",
    instruction: "Open Change Password without entering or submitting credentials.",
    expected: "The current-password, new-password and confirmation fields are secure and visible.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Change Password",
      },
    },
    checks: [
      {
        selector: {
          role: "AXTextField",
          subrole: "AXSecureTextField",
          placeholder: "Enter your current password",
        },
      },
      {
        selector: {
          role: "AXTextField",
          subrole: "AXSecureTextField",
          placeholder: "Enter your new password",
        },
      },
      {
        selector: {
          role: "AXTextField",
          subrole: "AXSecureTextField",
          placeholder: "Confirm your new password",
        },
      },
    ],
  },
  {
    id: "SET-03-back",
    instruction: "Return from Change Password using Back.",
    expected: "Profile Settings returns without changing credentials.",
    action: {
      op: "press",
      selector: {
        identifier: "navigation.back",
      },
    },
    checks: [
      {
        selector: {
          description: "Profile Settings",
        },
      },
      {
        selector: {
          placeholder: "Enter your current password",
        },
        absent: true,
      },
    ],
  },
  {
    id: "SET-04-open",
    instruction: "Open Change Email without requesting a verification email.",
    expected: "The new-email and secure-password fields are visible.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Change Email",
      },
    },
    checks: [
      {
        selector: {
          description: "Change Email",
        },
      },
      {
        selector: {
          placeholder: "New email address",
        },
      },
      {
        selector: {
          role: "AXTextField",
          subrole: "AXSecureTextField",
          placeholder: "Password",
        },
      },
      {
        selector: {
          contains: "Send Verification Email",
        },
      },
    ],
  },
  {
    id: "SET-04-back",
    instruction: "Return from Change Email using Back.",
    expected: "Profile Settings returns without an account change.",
    action: {
      op: "press",
      selector: {
        identifier: "navigation.back",
      },
    },
    checks: [
      {
        selector: {
          description: "Profile Settings",
        },
      },
      {
        selector: {
          placeholder: "New email address",
        },
        absent: true,
      },
    ],
  },
  {
    id: "SET-02-back",
    instruction: "Return from Profile to the main Settings screen.",
    expected: "The main Settings categories return.",
    action: {
      op: "press",
      selector: {
        identifier: "navigation.back",
      },
    },
    checks: [
      {
        selector: {
          description: "Account settings",
        },
      },
      {
        selector: {
          description: "Profile Settings",
        },
        absent: true,
      },
    ],
  },
  {
    id: "SET-05-open",
    instruction: "Open Feedback from Settings without submitting a report.",
    expected: "The feedback form exposes its expected-behavior and actual-behavior fields.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Feedback",
      },
    },
    checks: [
      {
        selector: {
          role: "AXTextArea",
          description: "Describe what you expected...",
          value: "",
        },
      },
      {
        selector: {
          role: "AXTextArea",
          description: "Describe what actually happened...",
          value: "",
        },
      },
      {
        selector: {
          description: "What did you expect to happen?",
        },
      },
    ],
  },
  {
    id: "SET-05-close",
    instruction: "Close the Settings miniapp from its feedback form using the capsule close control.",
    expected: "The feedback form closes and unpaired home returns.",
    action: {
      op: "press",
      selector: {
        identifier: "miniapp.close",
      },
    },
    checks: [
      {
        selector: {
          description: "What did you expect to happen?",
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
          identifier: "home.allApps.open",
        },
        count: 1,
      },
    ],
  },
  {
    id: "SET-06-settings",
    instruction: "Reopen Settings after closing its miniapp.",
    expected: "Settings opens at its main screen.",
    action: {
      op: "press",
      selector: {
        identifier: "home.miniapp.com.mentra.settings",
      },
    },
    checks: [
      {
        selector: {
          description: "Account settings",
        },
      },
    ],
  },
  {
    id: "SET-06-speech",
    instruction: "Open Speech without selecting a model or starting a download.",
    expected: "Speech opens and the captions-language section is visible.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Speech",
      },
    },
    checks: [
      {
        selector: {
          description: "Speech",
        },
      },
      {
        selector: {
          description: "Captions Language (Speech-to-Text)",
        },
      },
      {
        selector: {
          identifier: "navigation.back",
        },
        count: 1,
      },
    ],
    timeoutMs: 30000,
  },
  {
    id: "SET-06-scroll",
    instruction: "Scroll the Speech language list down by one page without selecting a language.",
    expected: "The voice-language section and additional languages are visible.",
    action: {
      op: "perform",
      selector: {
        role: "AXGenericElement",
        contains: "Fran\u00e7ais",
      },
      action: "AXScrollDownByPage",
    },
    checks: [
      {
        selector: {
          description: "Voice Language (Text-to-Speech)",
        },
      },
      {
        selector: {
          role: "AXGenericElement",
          contains: "English",
        },
      },
      {
        selector: {
          role: "AXGenericElement",
          contains: "Fran\u00e7ais",
        },
      },
    ],
  },
  {
    id: "SET-06-back",
    instruction: "Return from Speech without changing language preferences.",
    expected: "Main Settings returns.",
    action: {
      op: "press",
      selector: {
        identifier: "navigation.back",
      },
    },
    checks: [
      {
        selector: {
          description: "Account settings",
        },
      },
      {
        selector: {
          description: "Voice Language (Text-to-Speech)",
        },
        absent: true,
      },
    ],
  },
  {
    id: "SET-07-open",
    instruction: "Open Privacy without changing any operating-system permission.",
    expected: "Privacy Settings opens with a privacy-policy entry.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Privacy",
      },
    },
    checks: [
      {
        selector: {
          description: "Privacy Settings",
        },
      },
      {
        selector: {
          contains: "Privacy Policy",
        },
      },
      {
        selector: {
          identifier: "navigation.back",
        },
        count: 1,
      },
    ],
  },
  {
    id: "SET-07-back",
    instruction: "Return from Privacy without granting permissions or opening an external page.",
    expected: "Main Settings returns.",
    action: {
      op: "press",
      selector: {
        identifier: "navigation.back",
      },
    },
    checks: [
      {
        selector: {
          description: "Account settings",
        },
      },
      {
        selector: {
          description: "Privacy Settings",
        },
        absent: true,
      },
    ],
  },
  {
    id: "SET-08-open",
    instruction: "Open Miniapp Developer Settings without changing its preferences or loading a miniapp.",
    expected: "The developer information, home-screen preference, and miniapp loading tools appear.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Miniapp Developer Settings",
      },
    },
    checks: [
      {
        selector: {
          description: "Build a miniapp",
        },
      },
      {
        selector: {
          contains: "Show Miniapp Developer on Home Screen",
        },
      },
      {
        selector: {
          contains: "Scan Miniapp QR Code",
        },
      },
      {
        selector: {
          contains: "Load Miniapp from URL",
        },
      },
    ],
  },
  {
    id: "SET-08-back",
    instruction: "Return from Miniapp Developer Settings without changing its configuration.",
    expected: "Main Settings returns.",
    action: {
      op: "press",
      selector: {
        identifier: "navigation.back",
      },
    },
    checks: [
      {
        selector: {
          description: "Account settings",
        },
      },
      {
        selector: {
          description: "Build a miniapp",
        },
        absent: true,
      },
    ],
  },
  {
    id: "SET-10-home",
    instruction: "Minimize Settings to leave one known miniapp available in the switcher.",
    expected: "Home is visible and the Settings capsule is hidden.",
    action: {
      op: "press",
      selector: {
        identifier: "miniapp.minimize",
      },
    },
    checks: [
      {
        selector: {
          identifier: "miniapp.minimize",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "home.runningApps.open",
        },
        count: 1,
      },
    ],
  },
  {
    id: "HOME-07-open",
    instruction: "Open the running-miniapps switcher.",
    expected: "The Settings card and named close control are accessible.",
    action: {
      op: "press",
      selector: {
        identifier: "home.runningApps.open",
      },
    },
    checks: [
      {
        selector: {
          identifier: "runningApps.miniapp.com.mentra.settings",
        },
        count: 1,
      },
      {
        selector: {
          identifier: "home.runningApps.close",
        },
        count: 1,
      },
    ],
  },
  {
    id: "HOME-07-select",
    instruction: "Return to Settings from its running-miniapp card.",
    expected: "Account settings is visible and the switcher is closed.",
    action: {
      op: "press",
      selector: {
        identifier: "runningApps.miniapp.com.mentra.settings",
      },
    },
    checks: [
      {
        selector: {
          description: "Account settings",
        },
      },
      {
        selector: {
          identifier: "home.runningApps.close",
        },
        absent: true,
      },
    ],
  },
  {
    id: "HOME-07-minimize",
    instruction: "Minimize Settings again.",
    expected: "Home exposes its running-miniapps control.",
    action: {
      op: "press",
      selector: {
        identifier: "miniapp.minimize",
      },
    },
    checks: [
      {
        selector: {
          identifier: "home.runningApps.open",
        },
      },
      {
        selector: {
          identifier: "miniapp.minimize",
        },
        absent: true,
      },
    ],
  },
  {
    id: "HOME-07-reopen",
    instruction: "Reopen the running-miniapps switcher.",
    expected: "Settings remains in the running list.",
    action: {
      op: "press",
      selector: {
        identifier: "home.runningApps.open",
      },
    },
    checks: [
      {
        selector: {
          identifier: "runningApps.miniapp.com.mentra.settings",
        },
      },
    ],
  },
  {
    id: "HOME-07-close",
    instruction: "Close the running-miniapps list.",
    expected: "Home returns with the Settings card hidden.",
    action: {
      op: "press",
      selector: {
        identifier: "home.runningApps.close",
      },
    },
    checks: [
      {
        selector: {
          identifier: "runningApps.miniapp.com.mentra.settings",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "home.allApps.open",
        },
      },
    ],
  },
  {
    id: "DEVICE-01-open",
    instruction: "Open the glasses model selector from Pair glasses.",
    expected: "Select Model and the supported glasses choices are visible.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "Pair glasses",
      },
    },
    checks: [
      {
        selector: {
          description: "Select Model",
        },
      },
      {
        selector: {
          identifier: "pairing-model-mentra_live",
        },
      },
    ],
  },
  {
    id: "DEVICE-01-back",
    instruction: "Return without choosing a glasses model.",
    expected: "Unpaired home returns and the model selector is gone.",
    action: {
      op: "press",
      selector: {
        identifier: "navigation.back",
      },
    },
    checks: [
      {
        selector: {
          role: "AXButton",
          description: "Pair glasses",
        },
      },
      {
        selector: {
          description: "Select Model",
        },
        absent: true,
      },
    ],
  },
  {
    id: "APP-01-open",
    instruction: "Open Gallery without glasses connected.",
    expected: "The app explains that glasses must be connected to use Gallery.",
    action: {
      op: "press",
      selector: {
        identifier: "home.miniapp.com.mentra.camera",
      },
    },
    checks: [
      {
        selector: {
          description: "Glasses Required",
        },
      },
      {
        selector: {
          contains: "Connect your glasses to use Gallery.",
        },
      },
    ],
  },
  {
    id: "APP-01-close",
    instruction: "Dismiss Gallery's glasses-required dialog.",
    expected: "The dialog closes and home remains available.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "OK",
      },
    },
    checks: [
      {
        selector: {
          description: "Glasses Required",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "home.allApps.open",
        },
      },
    ],
  },
  {
    id: "APP-02-open",
    instruction: "Open Captions without glasses connected.",
    expected: "The app explains that glasses must be connected to use Captions.",
    action: {
      op: "press",
      selector: {
        identifier: "home.miniapp.com.mentra.captions",
      },
    },
    checks: [
      {
        selector: {
          description: "Glasses Required",
        },
      },
      {
        selector: {
          contains: "Connect your glasses to use Captions.",
        },
      },
    ],
  },
  {
    id: "APP-02-close",
    instruction: "Dismiss Captions' glasses-required dialog.",
    expected: "The dialog closes and home remains available.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "OK",
      },
    },
    checks: [
      {
        selector: {
          description: "Glasses Required",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "home.allApps.open",
        },
      },
    ],
  },
  {
    id: "AUTH-11-settings",
    instruction: "Open Settings before testing logout.",
    expected: "Account settings is visible.",
    action: {
      op: "press",
      selector: {
        identifier: "home.miniapp.com.mentra.settings",
      },
    },
    checks: [
      {
        selector: {
          description: "Account settings",
        },
      },
    ],
  },
  {
    id: "AUTH-11-profile",
    instruction: "Open Profile.",
    expected: "The Log Out control is available.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Profile",
      },
    },
    checks: [
      {
        selector: {
          description: "Profile Settings",
        },
      },
    ],
  },
  {
    id: "AUTH-11-scroll",
    instruction: "Scroll Profile to the session controls.",
    expected: "Log Out is visible.",
    action: {
      op: "perform",
      selector: {
        role: "AXGenericElement",
        contains: "Request Data Export",
      },
      action: "AXScrollDownByPage",
    },
    checks: [
      {
        selector: {
          contains: "Log Out",
        },
      },
    ],
  },
  {
    id: "AUTH-11-open",
    instruction: "Open the Log Out confirmation.",
    expected: "The confirmation offers Cancel.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Log Out",
      },
    },
    checks: [
      {
        selector: {
          role: "AXButton",
          description: "Cancel",
        },
      },
    ],
  },
  {
    id: "AUTH-11-cancel",
    instruction: "Cancel logout.",
    expected: "Profile remains visible and the confirmation is gone.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "Cancel",
      },
    },
    checks: [
      {
        selector: {
          description: "Profile Settings",
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
    id: "AUTH-12-open",
    instruction: "Open Log Out again.",
    expected: "The confirmation is visible.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        contains: "Log Out",
      },
    },
    checks: [
      {
        selector: {
          role: "AXButton",
          description: "Cancel",
        },
      },
    ],
  },
  {
    id: "AUTH-12-confirm",
    instruction: "Confirm logout.",
    expected: "The authentication start screen replaces the authenticated UI.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "Yes",
      },
    },
    checks: [
      {
        selector: {
          description: "The future of smart glasses starts here",
        },
      },
      {
        selector: {
          identifier: "home.allApps.open",
        },
        absent: true,
      },
      {
        selector: {
          identifier: "navigation.back",
        },
        absent: true,
      },
    ],
    timeoutMs: 30000,
  },
  {
    id: "AUTH-02",
    instruction: "Open Log In.",
    expected: "Email and secure password fields are visible.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        description: "Log In",
      },
    },
    checks: [
      {
        selector: {
          role: "AXTextField",
          placeholder: "Email address",
        },
      },
      {
        selector: {
          role: "AXTextField",
          subrole: "AXSecureTextField",
          placeholder: "Password",
        },
      },
    ],
  },
  {
    id: "AUTH-03-empty",
    instruction: "Submit the empty login form.",
    expected: "Local validation asks for an email address.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        contains: "Log In",
      },
    },
    checks: [
      {
        selector: {
          description: "Please enter your email address",
        },
      },
    ],
  },
  {
    id: "AUTH-03-dismiss",
    instruction: "Dismiss email-required validation.",
    expected: "The email field remains empty.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "OK",
      },
    },
    checks: [
      {
        selector: {
          role: "AXTextField",
          placeholder: "Email address",
          value: "",
        },
      },
      {
        selector: {
          description: "Please enter your email address",
        },
        absent: true,
      },
    ],
  },
  {
    id: "AUTH-04-enter",
    instruction: "Enter a malformed email.",
    expected: "The email field contains not-an-email.",
    action: {
      op: "type",
      method: "ax-value",
      selector: {
        role: "AXTextField",
        placeholder: "Email address",
      },
      text: "not-an-email",
    },
    checks: [
      {
        selector: {
          role: "AXTextField",
          placeholder: "Email address",
          value: "not-an-email",
        },
      },
    ],
  },
  {
    id: "AUTH-04-submit",
    instruction: "Submit the malformed email.",
    expected: "Local validation asks for a valid email.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        contains: "Log In",
      },
    },
    checks: [
      {
        selector: {
          description: "Please enter a valid email address",
        },
      },
    ],
  },
  {
    id: "AUTH-04-dismiss",
    instruction: "Dismiss invalid-email validation.",
    expected: "The login form returns.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "OK",
      },
    },
    checks: [
      {
        selector: {
          role: "AXTextField",
          placeholder: "Email address",
        },
      },
      {
        selector: {
          description: "Please enter a valid email address",
        },
        absent: true,
      },
    ],
  },
  {
    id: "AUTH-05-enter",
    instruction: "Enter the designated test account email without a password.",
    expected: "The email field contains the test account.",
    action: {
      op: "type",
      method: "ax-value",
      selector: {
        role: "AXTextField",
        placeholder: "Email address",
      },
      text: "__ACCOUNT_EMAIL__",
    },
    checks: [
      {
        selector: {
          role: "AXTextField",
          placeholder: "Email address",
          value: "__ACCOUNT_EMAIL__",
        },
      },
    ],
  },
  {
    id: "AUTH-05-submit",
    instruction: "Submit with an empty password.",
    expected: "Local validation asks for a password.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        contains: "Log In",
      },
    },
    checks: [
      {
        selector: {
          description: "Please enter your password",
        },
      },
    ],
  },
  {
    id: "AUTH-05-dismiss",
    instruction: "Dismiss password-required validation.",
    expected: "The login form returns.",
    action: {
      op: "press",
      selector: {
        role: "AXButton",
        description: "OK",
      },
    },
    checks: [
      {
        selector: {
          role: "AXTextField",
          placeholder: "Password",
        },
      },
      {
        selector: {
          description: "Please enter your password",
        },
        absent: true,
      },
    ],
  },
  {
    id: "AUTH-06-open",
    instruction: "Open Forgot your password without requesting an email.",
    expected: "The Forgot Password form opens.",
    action: {
      op: "press",
      selector: {
        role: "AXGenericElement",
        description: "Forgot your password?",
      },
    },
    checks: [
      {
        selector: {
          description: "Forgot Password",
        },
      },
    ],
  },
  {
    id: "AUTH-06-back",
    instruction: "Return from recovery without sending an email.",
    expected: "The login form is visible and recovery is gone.",
    action: {
      op: "press",
      selector: {
        identifier: "navigation.back",
      },
    },
    checks: [
      {
        selector: {
          role: "AXTextField",
          placeholder: "Password",
        },
      },
      {
        selector: {
          description: "Forgot Password",
        },
        absent: true,
      },
    ],
  },
  {
    id: "AUTH-07-back",
    instruction: "Return to the authentication start screen.",
    expected: "The start screen returns.",
    action: {
      op: "press",
      selector: {
        identifier: "navigation.back",
      },
    },
    checks: [
      {
        selector: {
          description: "The future of smart glasses starts here",
        },
      },
    ],
  },
]

const homeChecks = [
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
  },
  {
    selector: {
      identifier: "miniapp.close",
    },
    absent: true,
  },
  {
    selector: {
      identifier: "home.runningApps.close",
    },
    absent: true,
  },
  {
    selector: {
      description: "Glasses Required",
    },
    absent: true,
  },
]

function withAccount(step: Step): Step {
  if (!JSON.stringify(step).includes("__ACCOUNT_EMAIL__")) return step
  const checks = step.checks
  const action = step.action
  const substitute = <T>(value: T, email: string): T =>
    JSON.parse(JSON.stringify(value), (_key, field) => (field === "__ACCOUNT_EMAIL__" ? email : field))
  return {
    ...step,
    action: action
      ? (context) => substitute(action, context.email) as Exclude<Step["action"], Function | undefined>
      : undefined,
    checks: (context) => substitute(checks, context.email) as Exclude<Step["checks"], Function>,
  }
}

export const noGlasses: Step[] = [
  ...observed.map(withAccount),
  ...login.map((step) =>
    step.id === "AUTH-02"
      ? {...step, id: "AUTH-07-reopen"}
      : step.id === "AUTH-08.3"
        ? {
            ...step,
            expected: "The signed-in, unpaired account reaches the onboarding welcome screen.",
            checks: [{selector: {description: "Welcome to MentraOS"}}],
          }
        : step,
  ),
  ...onboarding,
  {
    id: "AUTH-10-settings",
    instruction: "Open Settings after signing back in.",
    expected: "Account settings is available.",
    action: {op: "press", selector: {identifier: "home.miniapp.com.mentra.settings"}},
    checks: [{selector: {description: "Account settings"}}],
  },
  {
    id: "AUTH-10-profile",
    instruction: "Verify the signed-in account identity again.",
    expected: "Profile shows the designated account email.",
    action: {op: "press", selector: {role: "AXGenericElement", contains: "Profile"}},
    checks: (context) => [
      {selector: {description: "Profile Settings"}},
      {selector: {role: "AXGenericElement", description: `Email, ${context.email}`}, count: 1},
    ],
  },
  {
    id: "AUTH-10-close",
    instruction: "Close Settings after verifying identity.",
    expected: "Unpaired home returns.",
    action: {op: "press", selector: {identifier: "miniapp.close"}},
    checks: homeChecks,
  },
  {
    id: "LIFE-02",
    instruction: "Quit and reopen the same app normally.",
    expected: "The stored session restores directly to unpaired home.",
    action: {op: "relaunch"},
    checks: homeChecks,
    timeoutMs: 30000,
  },
  {
    id: "END-01",
    instruction: "Verify the final home state.",
    expected: "Signed-in unpaired home is usable, with no test dialog, search sheet, or foreground miniapp.",
    checks: [
      ...homeChecks,
      {selector: {identifier: "home.allApps.search"}, absent: true},
      {selector: {placeholder: "Password"}, absent: true},
    ],
  },
]

export const noGlassesExclusions = [
  {
    id: "SET-09",
    instruction: "Appearance",
    reason: "The consumer fixture hides Appearance; its absence is asserted on Settings. No theme change is made.",
  },
  {
    id: "DEVICE-02",
    instruction: "Paired-disconnected coverage",
    reason: "This fixture is unpaired. A separate paired device fixture is required.",
  },
  {
    id: "APP-03",
    instruction: "Store details",
    reason:
      "This build exposes the local all-miniapps sheet, covered by HOME-02 through HOME-06, rather than a store/detail surface.",
  },
]
