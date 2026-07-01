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
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    // The launcher (`open`/`xdg-open`/`start`) exits quickly after handing the
    // URL to the browser, so wait for its exit code rather than resolving on
    // `spawn`. A non-zero exit means the launch failed and callers can fall
    // back to printing the URL.
    child.on("close", (code) => resolve(code === 0));
  });
}
