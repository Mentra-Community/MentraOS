import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { signOutLocally } from "../lib/account-actions";
import { createFakeAuth } from "../test-support/fake-auth";
import { SignedOutView } from "./signout";

const SRC = path.join(import.meta.dir, "..");

describe("/signout", () => {
  test("signs out with the local scope only, never the default or global scope", async () => {
    const auth = createFakeAuth();

    await signOutLocally(auth);

    expect(auth.signOut.mock.calls).toEqual([[{ scope: "local" }]]);
    expect(renderToStaticMarkup(<SignedOutView />)).toContain("Signed out of Mentra");

    // No source file may call signOut() without a scope or with the global scope.
    const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)].filter((file) => !file.includes(".test."));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(path.join(SRC, file), "utf8");
      expect(source).not.toMatch(/\.signOut\(\s*\)/);
      expect(source).not.toMatch(/scope:\s*["'](global|others)["']/);
    }
  });
});
