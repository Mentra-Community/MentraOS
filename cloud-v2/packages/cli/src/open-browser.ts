import { spawn } from "node:child_process";
import { platform } from "node:os";

export async function openBrowser(url: string): Promise<boolean> {
  const command =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "cmd"
        : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    // Detach from the child so a long-lived launcher (e.g. xdg-open staying
    // attached to the browser) can't keep the CLI's event loop alive after
    // login completes and we've already resolved.
    child.unref();

    // A spawn error (e.g. launcher not found) is a genuine failure; callers fall
    // back to printing the URL.
    child.on("error", () => done(false));
    // Some launchers (`open`, `start`) exit promptly; treat a fast non-zero exit
    // as a failure. But others (`xdg-open`) can stay attached to the browser, so
    // don't block the login flow waiting for exit: assume success once a short
    // window passes without an error/early failure so polling can start.
    child.on("close", (code) => done(code === 0));
    const timer = setTimeout(() => done(true), 500);
    if (typeof timer.unref === "function") timer.unref();
  });
}
