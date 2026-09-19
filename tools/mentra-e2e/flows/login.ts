import type {Step} from "../runner/suite"

export const emailField = {role: "AXTextField", placeholder: "Email address"}
export const passwordField = {role: "AXTextField", subrole: "AXSecureTextField", placeholder: "Password"}
export const backButton = {identifier: "navigation.back"}
export const startScreen = {description: "The future of smart glasses starts here"}

export const login: Step[] = [
  {
    id: "AUTH-02",
    instruction: "Open Log In.",
    expected: "Email and secure password fields are visible.",
    action: {op: "press", selector: {role: "AXGenericElement", description: "Log In"}},
    checks: [{selector: emailField}, {selector: passwordField}],
  },
  {
    id: "AUTH-08.1",
    instruction: "Enter the designated test account email.",
    expected: "The email field contains the designated account.",
    action: (context) => ({op: "type", method: "ax-value", selector: emailField, text: context.email}),
    checks: (context) => [{selector: {...emailField, value: context.email}}],
  },
  {
    id: "AUTH-08.2",
    instruction: "Enter the test account password in the secure field.",
    expected: "The password field remains secure.",
    action: (context) => ({op: "type", method: "ax-value", selector: passwordField, text: context.password}),
    checks: [{selector: passwordField}],
  },
  {
    id: "AUTH-08.3",
    instruction: "Submit Log In.",
    expected: "The authenticated app exposes Settings.",
    action: {op: "press", selector: {role: "AXButton", contains: "Log In"}},
    checks: [{selector: {contains: "Settings"}}],
    timeoutMs: 30000,
  },
]
