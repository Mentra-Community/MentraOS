/**
 * The words "seat" and "license" are not ones a person reads: a subscription is one person's right to a product, and a
 * workspace buys a number of subscriptions for a product (see the portal's `no-seat-words.test.tsx`, which drives the
 * whole pages). API and code names keep `licenses`, `seats`, `add_seats` and the rest, so the components' own text is
 * read for "seat" only.
 *
 * Two guards that the page-level one can't give:
 * - the dialogs and banners, in every state they have, including the ones that need a minute of polling to reach on a
 *   page (a purchase that has not reached Core, and the buyer's own license among the new ones);
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
import { LicensesUnavailable, TestModeBanner } from "./components/licenses/banners";
import { LinkDialog, type LinkOutcome } from "./components/licenses/buy-link";
import { NoSeat } from "./components/licenses/page-parts";
import { PurchaseDialog } from "./components/licenses/purchase-dialog";
import { licenseStrings as t } from "./strings/licenses";
import { catalogEntryFor } from "./test-billing-fixtures";
import { cleanup, render, setupDom, teardownDom, wordsUnder } from "./test-dom";
import { detailFor, offlineApi } from "./test-fixtures";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

const SEAT = /\bseats?\b/i;
/** What a drawn screen never says: "seat", nor "license" (a person reads "subscription"). Code keeps both words. */
const UNREAD = /\b(seats?|licenses?)\b/i;
/** The one place a person reads the word: the button Alex named "Buy more seats". */
const withoutBuyMoreSeats = (text: string) => text.replaceAll(t.actions.addSeats, "");

async function draw(ui: ReactElement) {
  await render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
  return wordsUnder();
}

describe("the dialogs and banners, in every state", () => {
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
              <PurchaseDialog
                purchase={{ status: state.status, quantity, paid }}
                productName="Mentra Call Unlimited"
                entry={catalogEntryFor()}
                assigned={assigned}
                listed={state.listed}
                timedOut={state.timedOut}
                onClose={noop}
                onReload={noop}
              />,
            );
            const where = JSON.stringify({ assigned, paid, quantity, ...state });
            expect([where, words.filter((word) => UNREAD.test(word))]).toEqual([where, []]);
            // The dialog said something.
            expect(words.length).toBeGreaterThan(2);
            drawn++;
            await cleanup();
          }
        }
      }
    }
    expect(drawn).toBe(32);
  });

  test("back from the hosted page that added a license, in each state it shows", async () => {
    for (const state of [
      { held: false, timedOut: false },
      { held: true, timedOut: false },
      { held: false, timedOut: true },
    ]) {
      const words = await draw(
        <PurchaseDialog
          purchase={{ status: state.held ? "ready" : "processing", quantity: 1, paid: false }}
          productName="Mentra Call Unlimited"
          entry={catalogEntryFor()}
          listed={state.held}
          assigned={state.held}
          timedOut={state.timedOut}
          onClose={noop}
          onReload={noop}
        />,
      );
      expect([JSON.stringify(state), words.filter((word) => UNREAD.test(word))]).toEqual([JSON.stringify(state), []]);
      expect(words.length).toBeGreaterThan(2);
      await cleanup();
    }
  });

  test("every answer the ?buy= link can give", async () => {
    const entry = catalogEntryFor();
    const add = { kind: "add_seats", fallbackLabel: "Buy more seats" };
    const outcomes: Array<Exclude<LinkOutcome, { kind: "choose" }>> = [
      { product: entry.product, entry, kind: "held" },
      { product: entry.product, entry, kind: "assign", licenseId: "lic_call" },
      { product: entry.product, entry, kind: "add", licenseId: "lic_call", action: add },
      { product: entry.product, entry, kind: "buy" },
      { product: entry.product, entry, kind: "full", count: 3, people: ["Ana Ruiz"] },
      { product: entry.product, entry, kind: "already_has" },
      { product: entry.product, entry, kind: "ask" },
      { product: entry.product, entry, kind: "not_here" },
      { product: entry.product, entry, kind: "not_for_sale" },
      { product: "mentra.nope", entry: null, kind: "ask" },
    ];
    for (const outcome of outcomes) {
      const { api } = offlineApi();
      const words = await draw(
        <LinkDialog
          outcome={outcome}
          workspace={detailFor("admin") as never}
          api={api}
          billing={{ locale: "en-US" } as never}
          scope={{ workspaceId: "ws_acme" } as never}
          navigateOut={{ leave: noop, openTab: () => null }}
          onClose={noop}
        />,
      );
      expect([outcome.kind, words.filter((word) => UNREAD.test(word))]).toEqual([outcome.kind, []]);
      // An assignment draws nothing until it is done.
      if (outcome.kind !== "assign") expect(words.length).toBeGreaterThan(2);
      await cleanup();
    }
  });

  test("test mode, a member with nothing, and the unavailable pages", async () => {
    const screens: Array<[string, ReactElement]> = [
      ["test mode", <TestModeBanner testMode={{ cardNumber: "4242424242424242", environment: "Staging" }} />],
      ["a member with no subscription", <NoSeat workspaceName="Acme Field Services" />],
      ["unavailable", <LicensesUnavailable onRetry={noop} />],
      ["unavailable, retrying", <LicensesUnavailable onRetry={noop} retrying />],
    ];
    for (const [screen, ui] of screens) {
      const words = await draw(ui);
      expect([screen, words.filter((word) => UNREAD.test(word))]).toEqual([screen, []]);
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
        .filter((entry) => SEAT.test(withoutBuyMoreSeats(entry.text)))
        .map((entry) => `${relative(SRC, file)}:${entry.line} ${entry.text}`),
    );
    expect(stray).toEqual([]);
  });
});
