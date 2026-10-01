import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { CATALOG_REQUEST_ROUTINE_IDS, CATALOG_ROUTINE_IDS, ROUTINE_CATALOG } from "./routine-catalog-data";
import { RoutineCatalogPage } from "./routine-catalog";

test("the human catalog includes five full foundation combinations without enabling local-only requests", () => {
  expect(CATALOG_ROUTINE_IDS).toEqual(["ota-roundtrip-android", "no-glasses", "no-glasses-android", "captions-phone", "notes-phone"]);
  expect(CATALOG_REQUEST_ROUTINE_IDS).toEqual(["no-glasses", "no-glasses-android", "captions-phone", "notes-phone"]);
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <RoutineCatalogPage onResult={() => {}} />
  </QueryClientProvider>);
  expect(markup.match(/<article /g)).toHaveLength(5);
  expect(markup).toContain("Local replay only.");
  expect(markup).not.toContain("routine:ota-roundtrip-android");
  expect(markup).toContain("These are local development passes. CI, nightly runs and other builds need their own qualification.");
  expect(markup).toContain("No physical glasses or glasses firmware required or qualified");
  expect(markup).toContain("Run routine");
  expect(markup).toContain("gh pr edit 123 --repo Mentra-Community/MentraOS --add-label routine:captions-phone");
  for (const id of ["day1-ota", "mentra-call", "account-miniapps", "connected-glasses", "livestreamer"])
    expect(markup).not.toContain(`routine:${id}`);
});

test("each platform has requirements, truthful request availability and a dev result link", () => {
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <RoutineCatalogPage onResult={() => {}} />
  </QueryClientProvider>);
  for (const routine of ROUTINE_CATALOG) {
    if (routine.request) expect(markup).toContain(`routine:${routine.request.routineId}`);
    else expect(markup).not.toContain(`routine:${routine.id}`);
    expect(markup).toContain(`href="https://admin.dev.mentraglass.com/?testRun=${routine.passingRun.id}"`);
    expect(markup).toContain(`https://github.com/Mentra-Community/MentraOS/commit/${routine.passingRun.appSha}`);
  }
  for (const label of ["Software", "Glasses and firmware", "Account", "Network", "Physical setup", "Test data", "Cleanup", "Outside this routine"])
    expect(markup.match(new RegExp(`>${label}</`, "g"))).toHaveLength(5);
  expect(markup).toContain("mini-060b");
  expect(markup).toContain("302014623");
  expect(markup).toContain("BES and MTK firmware intentionally remain installed");
  expect(markup).toContain("Samsung Galaxy A54");
  expect(markup).toContain("mini-samsung-a54");
  expect(markup).toContain("303000084");
  expect(markup).toContain("310000290");
});
