import type {Step} from "../runner/suite"

const start = {description: "The future of smart glasses starts here"}
const email = {role: "AXTextField", placeholder: "Email address"}
const password = {role: "AXTextField", subrole: "AXSecureTextField", placeholder: "Password"}
const submit = {role: "AXButton", contains: "Log In"}
const back = {identifier: "navigation.back"}

export const driverProof: Step[] = [
  {
    id: "PROOF-01",
    instruction: "Observe the signed-out start screen.",
    expected: "The Mentra authentication start screen is visible.",
    checks: [{selector: start}],
  },
  {
    id: "PROOF-02",
    instruction: "Open Log In.",
    expected: "The email and secure password fields are visible.",
    action: {op: "press", selector: {role: "AXGenericElement", description: "Log In"}},
    checks: [{selector: email}, {selector: password}],
  },
  {
    id: "PROOF-03",
    instruction: "Enter a deliberately malformed email.",
    expected: "The field contains not-an-email.",
    action: {op: "type", method: "ax-value", selector: email, text: "not-an-email"},
    checks: [{selector: {...email, value: "not-an-email"}}],
  },
  {
    id: "PROOF-04",
    instruction: "Submit the malformed email.",
    expected: "The app presents local invalid-email validation.",
    action: {op: "press", selector: submit},
    checks: [{selector: {contains: "valid email"}}],
  },
  {
    id: "PROOF-05",
    instruction: "Dismiss validation.",
    expected: "The login form is available again.",
    action: {op: "press", selector: {role: "AXButton", description: "OK"}},
    checks: [{selector: email}],
  },
  {
    id: "PROOF-06",
    instruction: "Clear the test email.",
    expected: "The email field is empty.",
    action: {op: "type", method: "ax-value", selector: email, text: ""},
    checks: [{selector: {...email, value: ""}}],
  },
  {
    id: "PROOF-07",
    instruction: "Return to the authentication start screen.",
    expected: "The original start screen is restored.",
    action: {op: "press", selector: back},
    checks: [{selector: start}],
  },
]
