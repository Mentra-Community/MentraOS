import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {LoadingIndicator} from "./loading-indicator";
import {TestingButton} from "./testing-ui";

test("loading contexts have a real spinner, concise copy and an accessible name", () => {
  const html = renderToStaticMarkup(<LoadingIndicator label="Loading lane reports" />);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-label="Loading lane reports"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain("animate-spin");
  expect(html).toContain("motion-reduce:animate-none");
  expect(html).toContain("<span>Loading</span>");
  expect(html).not.toContain("…");
});

test("an active action keeps its name and prevents a second submission", () => {
  const html = renderToStaticMarkup(<TestingButton busy>Run routine</TestingButton>);
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('disabled=""');
  expect(html).toContain("animate-spin");
  expect(html).toContain("Run routine");
});
