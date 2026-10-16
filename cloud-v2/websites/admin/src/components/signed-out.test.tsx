import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignedOutScreen } from "./signed-out";

test("the signed-out screen offers the Mentra sign-out", () => {
  const html = renderToStaticMarkup(<SignedOutScreen signOutUrl="https://account.test/signout" />);
  expect(html).toContain("Signed out of the admin portal");
  expect(html).toContain('href="https://account.test/signout"');
  expect(html).toContain("Sign out of your Mentra account");
});

test("a null signOutUrl shows no Mentra sign-out link", () => {
  const html = renderToStaticMarkup(<SignedOutScreen signOutUrl={null} />);
  expect(html).toContain("Signed out of the admin portal");
  expect(html).not.toContain("Sign out of your Mentra account");
});
