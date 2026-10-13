import { expect, test } from "bun:test";
import { developerConsoleUrl } from "./config";

test("the Developer Console is an absolute http(s) URL, without a trailing slash", () => {
  expect(developerConsoleUrl("https://console.mentraglass.com")).toBe("https://console.mentraglass.com");
  expect(developerConsoleUrl(" https://console.dev.mentraglass.com/ ")).toBe("https://console.dev.mentraglass.com");
  expect(developerConsoleUrl("http://localhost:5173")).toBe("http://localhost:5173");
});

test("a build without one (a Private Cloud, CI or a local build) has no Developer Console", () => {
  expect(developerConsoleUrl(undefined)).toBeNull();
  expect(developerConsoleUrl("")).toBeNull();
  expect(developerConsoleUrl("   ")).toBeNull();
});

test("a relative or non-http value is not a Developer Console", () => {
  expect(developerConsoleUrl("console.mentraglass.com")).toBeNull();
  expect(developerConsoleUrl("/console")).toBeNull();
  expect(developerConsoleUrl("javascript:alert(1)")).toBeNull();
});
