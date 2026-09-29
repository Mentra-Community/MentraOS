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

test("admin matching normalizes allowlists and preserves exact mailbox and domain boundaries", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = " Named@personal.test , api-key@service.local ";
  process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = " company.test, @SECOND.test ";
  for (const email of [" NAMED@PERSONAL.TEST ", "api-key@service.local", "user@company.test", "user@second.test"]) {
    expect(isAdminEmail(email)).toBe(true);
  }
  for (const email of ["other@personal.test", "user@sub.company.test", "user@company.test.evil.test", "user@notcompany.test"]) {
    expect(isAdminEmail(email)).toBe(false);
  }
});

test("plus tags inherit an allowlisted base email for any domain", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = "example-admin@gmail.com, named@personal.test";
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS;
  for (const email of ["example-admin@gmail.com", "example-admin+test@gmail.com",
    " EXAMPLE-ADMIN+one+two@GMAIL.COM ", "named+test@personal.test"]) {
    expect(isAdminEmail(email)).toBe(true);
  }
  for (const email of ["example-admin2+test@gmail.com", "other+example-admin@gmail.com",
    "example-admin+test@evil.test", "example-admin+test@gmail.com.evil.test",
    "example-admin+@gmail.com", "example-admin+test@evil@gmail.com",
    "example-admin+test @gmail.com", "+test@gmail.com"]) {
    expect(isAdminEmail(email)).toBe(false);
  }
  process.env.CLOUD_CORE_ADMIN_EMAILS = "";
  expect(isAdminEmail("example-admin+test@gmail.com")).toBe(false);
});

test("an explicitly allowlisted tagged address does not allow its base or sibling aliases", () => {
  process.env.CLOUD_CORE_ADMIN_EMAILS = "named+specific@personal.test";
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS;
  expect(isAdminEmail("named+specific@personal.test")).toBe(true);
  expect(isAdminEmail("named@personal.test")).toBe(false);
  expect(isAdminEmail("named+other@personal.test")).toBe(false);
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
