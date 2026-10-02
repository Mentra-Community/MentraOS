import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { CATALOG_REQUEST_ROUTINE_IDS, CATALOG_ROUTINE_IDS, ROUTINE_CATALOG } from "./routine-catalog-data";
import { RoutineCatalogPage } from "./routine-catalog";

test("the human catalog includes six full foundation combinations without enabling local-only requests", () => {
  expect(CATALOG_ROUTINE_IDS).toEqual(["ota-roundtrip-android", "no-glasses", "no-glasses-android", "captions-phone", "connected-glasses", "notes-phone"]);
  expect(CATALOG_REQUEST_ROUTINE_IDS).toEqual(["no-glasses", "no-glasses-android", "captions-phone", "notes-phone"]);
  const markup = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <RoutineCatalogPage onResult={() => {}} />
  </QueryClientProvider>);
  expect(markup.match(/<article /g)).toHaveLength(6);
  expect(markup).toContain("Enrolled in dev nightly. Manual and PR requests are not enabled for this routine.");
  expect(markup.match(/Dev nightly pass/g)).toHaveLength(4);
  expect(markup.match(/>Development pass</g)).toHaveLength(2);
  expect(markup.match(/View completed nightly suite/g)).toHaveLength(4);
  expect(markup).toContain("label shown on a request-enabled card. Routines without a request label cannot be requested here.");
  expect(markup).not.toContain("routine:ota-roundtrip-android");
  expect(markup).toContain("Each card distinguishes a development pass from a completed dev nightly result. Other builds and triggers need their own qualification.");
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
    expect(markup.match(new RegExp(`>${label}</`, "g"))).toHaveLength(6);
  expect(markup).toContain("mini-060b");
  expect(markup).toContain("310000349");
  expect(markup).toContain("BES and MTK firmware intentionally remain installed");
  expect(markup).toContain("Samsung Galaxy A54");
  expect(markup).toContain("mini-samsung-a54");
  expect(markup).toContain("303000125");
  expect(markup).toContain("310000352");
});
