/**
 * The word "seat" is not one a person reads: a license is one person's right to a product, and a workspace buys a
 * number of licenses for a product (see the portal's `no-seat-words.test.tsx`, which drives the whole pages). API and
 * code names keep `seats`, `add_seats` and the rest.
 *
 * Two guards that the page-level one can't give:
 * - the banners, in every state they have, including the ones that need a minute of polling to reach on a page
 *   (a purchase that has not reached Core, and the buyer's own license among the new ones);
 * - the components' own text. A sentence belongs in `strings/licenses.ts`, and a literal or an `aria-label` written
 *   in a component is where a stray word would hide, so every string, template and piece of JSX text in the
 *   components, the controls and the audit labels is read for the word, whether or not any screen draws it.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ts from "typescript";
import type { ReactElement } from "react";
import { LicensesSummary, LicensesUnavailable, PurchaseBanner, TestModeBanner } from "./components/licenses/banners";
import { NoSeat } from "./components/licenses/page-parts";
import { cleanup, render, setupDom, teardownDom, wordsUnder } from "./test-dom";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

const SEAT = /\bseats?\b/i;

async function draw(ui: ReactElement) {
  await render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
  return wordsUnder();
}

describe("the banners, in every state", () => {
  const noop = () => {};

  test("after checkout, with and without the buyer's own license: setting up, ready, and not in Core after a minute", async () => {
    let drawn = 0;
    for (const assigned of [false, true]) {
      for (const paid of [true, false]) {
        for (const quantity of [1, 5]) {
          const states = [
            { status: "processing" as const, listed: false, timedOut: false },
            { status: "ready" as const, listed: true, timedOut: false },
            { status: "ready" as const, listed: false, timedOut: true },
            { status: "processing" as const, listed: false, timedOut: true },
          ];
          for (const state of states) {
            const words = await draw(
              <PurchaseBanner
                purchase={{ status: state.status, quantity, paid }}
                productName="Mentra Call Unlimited"
                assigned={assigned}
                listed={state.listed}
                timedOut={state.timedOut}
                onDismiss={noop}
                onReload={noop}
              />,
            );
            const where = JSON.stringify({ assigned, paid, quantity, ...state });
            expect([where, words.filter((word) => SEAT.test(word))]).toEqual([where, []]);
            // The banner said something.
            expect(words.length).toBeGreaterThan(2);
            drawn++;
            await cleanup();
          }
        }
      }
    }
    expect(drawn).toBe(32);
  });

  test("test mode, the total, a member with nothing, and the unavailable pages", async () => {
    const screens: Array<[string, ReactElement]> = [
      ["test mode", <TestModeBanner testMode={{ cardNumber: "4242424242424242", environment: "Staging" }} />],
      [
        "the total",
        <LicensesSummary
          total={{ amount: { amountMinor: 29500, currency: "USD" }, recurrence: { interval: "month", count: 1 }, tax: "excluded", licenseCount: 2 }}
          locale="en-US"
        />,
      ],
      ["a member with no license", <NoSeat workspaceName="Acme Field Services" />],
      ["unavailable", <LicensesUnavailable onRetry={noop} />],
      ["unavailable, retrying", <LicensesUnavailable onRetry={noop} retrying />],
    ];
    for (const [screen, ui] of screens) {
      const words = await draw(ui);
      expect([screen, words.filter((word) => SEAT.test(word))]).toEqual([screen, []]);
      expect(words.length).toBeGreaterThan(0);
      await cleanup();
    }
  });
});

// ---- the components' own text ----------------------------------------------------------------------------------

const SRC = join(import.meta.dir);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every string, template and JSX text in `file` that a person could read, with its line. Property names, type names and imports are code. */
function literals(file: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    const isName = ts.isPropertyAssignment(node.parent ?? node) && (node.parent as ts.PropertyAssignment).name === node;
    // `Pick<LicenseView, "seats">` names a field of a type.
    const isType = ts.isLiteralTypeNode(node.parent ?? node);
    if (isText && !isName && !isType) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.getText().trim() });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the components' own text", () => {
  // `api.ts` is the HTTP client: its paths are `/licenses/:id/seats/:membershipId` and `/seat-assignments`, which are code.
  const files = sourceFiles(SRC).filter((file) => relative(SRC, file) !== "api.ts" && !relative(SRC, file).startsWith("test-"));

  test("reads the components, the controls, the shell, the audit labels and the strings", () => {
    const names = files.map((file) => relative(SRC, file));
    for (const expected of ["components/licenses/seats.tsx", "components/licenses/catalog.tsx", "components/members-panel.tsx", "components/confirm-dialog.tsx", "lib/audit.ts", "strings/licenses.ts", "ui/stepper.tsx"]) {
      expect(names).toContain(expected);
    }
    expect(files.flatMap(literals).length).toBeGreaterThan(1000);
  });

  test("none says seat", () => {
    const stray = files.flatMap((file) =>
      literals(file)
        .filter((entry) => SEAT.test(entry.text))
        .map((entry) => `${relative(SRC, file)}:${entry.line} ${entry.text}`),
    );
    expect(stray).toEqual([]);
  });
});
