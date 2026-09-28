import { afterEach, expect, test } from "bun:test";
import { isAdminEmail } from "./admin-email-policy";

const savedEmails = process.env.CLOUD_CORE_ADMIN_EMAILS;
const savedDomains = process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS;
afterEach(() => {
  if (savedEmails === undefined) delete process.env.CLOUD_CORE_ADMIN_EMAILS;
  else process.env.CLOUD_CORE_ADMIN_EMAILS = savedEmails;
  if (savedDomains === undefined) delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS;
  else process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = savedDomains;
});

test("admin matching normalizes allowlists and only admits exact emails or domains", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = " Named@personal.test , api-key@service.local ";
  process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = " company.test, @SECOND.test ";
  for (const email of [" NAMED@PERSONAL.TEST ", "api-key@service.local", "user@company.test", "user@second.test"]) {
    expect(isAdminEmail(email)).toBe(true);
  }
  for (const email of ["other@personal.test", "user@sub.company.test", "user@company.test.evil.test", "user@notcompany.test"]) {
    expect(isAdminEmail(email)).toBe(false);
  }
});

test("missing allowlists fail closed and changes are read at use time", () => {
  delete process.env.CLOUD_CORE_ADMIN_EMAILS;
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS;
  expect(isAdminEmail("user@mentraglass.com")).toBe(false);
  process.env.CLOUD_CORE_ADMIN_EMAILS = "user@personal.test";
  expect(isAdminEmail("user@personal.test")).toBe(true);
  process.env.CLOUD_CORE_ADMIN_EMAILS = "";
  expect(isAdminEmail("user@personal.test")).toBe(false);
});
