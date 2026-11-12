import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {LoadingIndicator} from "./loading-indicator";

test("loading contexts have a real spinner, concise copy and an accessible name", () => {
  const html = renderToStaticMarkup(<LoadingIndicator label="Loading reports" />);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-label="Loading reports"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("animate-spin");
  expect(html).toContain("motion-reduce:animate-none");
  expect(html).toContain("<span>Loading</span>");
  expect(html).not.toContain("…");
});
