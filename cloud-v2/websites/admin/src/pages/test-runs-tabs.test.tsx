import {expect, test} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {TestRunsTabs} from "./test-runs-tabs";

test("test run tools have three ordered, accessible tabs with results selected initially", () => {
 const client = new QueryClient();
 client.setQueryData(["dispatch-routines"], {routines: []});
 client.setQueryData(["framework-activity"], {requests: []});
 const html = renderToStaticMarkup(<QueryClientProvider client={client}><TestRunsTabs><p>Recorded history</p></TestRunsTabs></QueryClientProvider>);
 const buttons = html.match(/<button[^>]*role="tab"[^>]*>.*?<\/button>/g) ?? [];
 expect(buttons).toHaveLength(3);
 expect(buttons.map(button => button.match(/>([^<]*)<\/button>/)?.[1])).toEqual(["Test runs", "Run a routine", "Request delivery"]);
 expect(buttons[0]).toContain('aria-selected="true"');
 expect(buttons[0]).toContain('tabindex="0"');
 expect(buttons[1]).toContain('aria-selected="false"');
 expect(buttons[2]).toContain('tabindex="-1"');
 const panels = html.match(/<div[^>]*role="tabpanel"[^>]*>/g) ?? [];
 expect(panels).toHaveLength(3);
 expect(panels[0]).not.toContain('hidden=""');
 expect(panels[1]).toContain('hidden=""');
 expect(panels[2]).toContain('hidden=""');
 buttons.forEach((button, index) => {
   const controls = button.match(/aria-controls="([^"]*)"/)?.[1];
   expect(panels[index]).toContain(`id="${controls}"`);
 });
 expect(html).toContain("Recorded history");
 expect((client.getQueryCache().find({queryKey: ["dispatch-routines", ""]})?.options as {enabled?: boolean}).enabled).toBe(false);
 expect((client.getQueryCache().find({queryKey: ["framework-activity"]})?.options as {enabled?: boolean}).enabled).toBe(false);
});
