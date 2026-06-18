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
    child.on("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}
