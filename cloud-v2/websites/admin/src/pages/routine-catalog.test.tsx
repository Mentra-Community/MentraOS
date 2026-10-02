import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {RoutineCatalogCard, routineHref} from "./routine-catalog";
import type {RoutineEnrollment} from "../../../../packages/core/src/types/routine-definition.types";

test("catalog does not present a missing current example as passing", () => {
  const routine = {routineId: "notes-phone", platform: "ios-on-mac", definitionRevision: "new",
    definition: {title: "Notes", purpose: "Create and find a note"}} as RoutineEnrollment;
  const markup = renderToStaticMarkup(<RoutineCatalogCard routine={{...routine, example: null}} />);
  expect(markup).toContain("Awaiting a complete pass for this revision");
  expect(markup).not.toContain("Complete passing example available");
  expect(markup).toContain("routine=notes-phone&amp;platform=ios-on-mac");
  expect(routineHref("notes-phone", "ios-on-mac")).toBe("/?routineCatalog=1&routine=notes-phone&platform=ios-on-mac");
});
