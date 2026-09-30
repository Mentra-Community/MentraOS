import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { CATALOG_ROUTINE_IDS, ROUTINE_CATALOG } from "./routine-catalog-data";
import { RoutineCatalogPage } from "./routine-catalog";

test("the human catalog includes only the four full foundation combinations", () => {
  expect(CATALOG_ROUTINE_IDS).toEqual(["no-glasses", "no-glasses-android", "captions-phone", "notes-phone"]);
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <RoutineCatalogPage onResult={() => {}} />
  </QueryClientProvider>);
  expect(markup.match(/<article /g)).toHaveLength(4);
  expect(markup).toContain("They do not establish CI enrollment, nightly coverage or a pass on another PR or build.");
  expect(markup).toContain("no glasses firmware is required or qualified");
  expect(markup).toContain("Run routine");
  expect(markup).toContain("gh pr edit 123 --repo Mentra-Community/MentraOS --add-label routine:captions-phone");
  for (const id of ["day1-ota", "mentra-call", "account-miniapps", "connected-glasses", "livestreamer"])
    expect(markup).not.toContain(`routine:${id}`);
});

test("each platform has requirements, a label and a dev result link independent of the current Admin environment", () => {
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <RoutineCatalogPage onResult={() => {}} />
  </QueryClientProvider>);
  for (const routine of ROUTINE_CATALOG) {
    expect(markup).toContain(`routine:${routine.id}`);
    expect(markup).toContain(`href="https://admin.dev.mentraglass.com/?testRun=${routine.passingRun.id}"`);
    expect(markup).toContain(`https://github.com/Mentra-Community/MentraOS/commit/${routine.passingRun.appSha}`);
  }
  for (const label of ["Software", "Account", "Network", "Physical setup", "Test data", "Cleanup", "Outside this routine"])
    expect(markup.match(new RegExp(`>${label}</`, "g"))).toHaveLength(4);
  expect(markup).toContain("Samsung Galaxy A54");
  expect(markup).toContain("mini-samsung-a54");
  expect(markup).toContain("303000084");
  expect(markup).toContain("310000290");
});
