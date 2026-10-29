import { describe, expect, test } from "bun:test";
import { readEmailLinkLanding } from "./email-link";

describe("readEmailLinkLanding", () => {
  test("a confirmed sign-up, email change or invite is verified", () => {
    for (const type of ["signup", "email_change", "invite"]) {
      expect(readEmailLinkLanding(`#access_token=a.b.c&refresh_token=r&expires_in=3600&type=${type}`)).toEqual({
        kind: "verified",
      });
    }
  });

  test("an expired or invalid link failed", () => {
    expect(
      readEmailLinkLanding(
        "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      ),
    ).toEqual({ kind: "failed" });
    expect(readEmailLinkLanding("#error_code=bad_jwt")).toEqual({ kind: "failed" });
  });

  test("anything else is not an email link", () => {
    for (const hash of ["", "#", "#section", "#access_token=a.b.c", "#access_token=a.b.c&type=recovery", "#type=signup"]) {
      expect(readEmailLinkLanding(hash)).toBeNull();
    }
  });
});
