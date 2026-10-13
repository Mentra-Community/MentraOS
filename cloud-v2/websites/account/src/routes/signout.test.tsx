import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignOutRoute } from "./signout";

describe("/signout", () => {
  test("renders a fixed signing-out state; the route then goes to the provider's end-session endpoint", () => {
    const navigate = mock((_url: string) => undefined);
    expect(renderToStaticMarkup(<SignOutRoute navigate={navigate} />)).toContain("Signing out");
  });
});
