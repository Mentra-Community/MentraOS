import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignedOutScreen } from "./signed-out";

test("the signed-out screen says one thing and offers only Sign in again", () => {
  const html = renderToStaticMarkup(<SignedOutScreen />);
  expect(html).toContain("Signed out of the admin portal");
  expect(html).toContain("You can close this tab.");
  expect(html).toContain('href="/"');
  expect(html).toContain(">Sign in again<");
  expect(html.match(/<a /g)).toHaveLength(1);
  expect(html).not.toContain("Sign out of your Mentra account");
  expect(html).not.toContain("still signed in");
});
