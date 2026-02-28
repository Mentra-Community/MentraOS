/**
 * warning.ts
 *
 * This file defines styled warning messages that are displayed when an app
 * attempts to use functionality requiring permissions it hasn't declared.
 *
 * Each function generates a bordered terminal warning box with:
 * - ASCII art logo (left side)
 * - Permission requirement details (right side)
 * - Link to developer portal for adding permissions
 *
 * The warnings use chalk for terminal colors and boxen for bordered output,
 * creating a professional side-by-side layout that alerts developers to
 * missing permissions in their app configuration.
 *
 * These are shown during SDK runtime when permission checks fail, helping
 * developers identify and fix permission issues quickly.
 */
import chalk from "chalk";
import boxen from "boxen";
import { warnLog } from "./logos";

const createPermissionWarning = (
  permissionName: string,
  funcName?: string,
  packageName?: string,
): string => {
  // Strip ANSI codes for width calculation
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (str: string) => str.replace(/\u001b\[\d+m/g, "");

  const title = chalk.bold.yellow("⚠️  Permission Required");
  const message = `${chalk.yellow(funcName || "This function")} requires ${chalk.bold(permissionName)} permission.`;
  const instructions = chalk.dim(
    "Please enable this permission in the developer portal at:",
  );
  const url = chalk.cyan.underline(
    `https://console.mentra.glass/apps/${packageName}/edit`,
  );
  const hint = chalk.dim("under *Required Permissions*.");

  // Split logo into lines (without color for width calculation)
  const logoLines = warnLog.split("\n");
  const coloredLogoLines = logoLines.map((line) => chalk.yellow(line));

  const textContent = [title, "", message, "", instructions, url, "", hint];

  // Find actual logo width (max line length without ANSI codes)
  const logoWidth = Math.max(
    ...logoLines.map((line) => stripAnsi(line).length),
  );

  // Create side-by-side layout
  const maxLines = Math.max(coloredLogoLines.length, textContent.length);
  const combinedLines: string[] = [];

  for (let i = 0; i < maxLines; i++) {
    const rawLogoLine = logoLines[i] || "";
    const coloredLogoLine = coloredLogoLines[i] || "";
    const actualLogoLength = stripAnsi(rawLogoLine).length;
    const padding = " ".repeat(Math.max(0, logoWidth - actualLogoLength));
    const textLine = textContent[i] || "";
    combinedLines.push(`${coloredLogoLine}${padding}    ${textLine}`);
  }

  return boxen(combinedLines.join("\n"), {
    padding: 1,
    margin: 1,
    borderStyle: "round",
    borderColor: "yellow",
    float: "left",
  });
};

export const noMicrophoneWarn = (
  funcName?: string,
  packageName?: string,
): string => {
  return createPermissionWarning("microphone", funcName, packageName);
};

export const locationWarn = (
  funcName?: string,
  packageName?: string,
): string => {
  return createPermissionWarning("location", funcName, packageName);
};

export const baackgroundLocationWarn = (
  funcName?: string,
  packageName?: string,
): string => {
  return createPermissionWarning("background location", funcName, packageName);
};

export const calendarWarn = (
  funcName?: string,
  packageName?: string,
): string => {
  return createPermissionWarning("calendar", funcName, packageName);
};

export const readNotficationWarn = (
  funcName?: string,
  packageName?: string,
): string => {
  return createPermissionWarning("read notification", funcName, packageName);
};

export const postNotficationWarn = (
  funcName?: string,
  packageName?: string,
): string => {
  return createPermissionWarning("post notification", funcName, packageName);
};

export const cameraWarn = (funcName?: string, packageName?: string): string => {
  return createPermissionWarning("camera", funcName, packageName);
};
