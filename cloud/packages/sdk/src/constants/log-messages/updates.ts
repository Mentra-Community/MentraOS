/**
 * updates.ts
 *
 * This file defines constant messages that should be displayed
 * in the terminal to notify developers about new SDK releases.
 *
 * Each function generates a stylized ASCII message (banner-style)
 * that highlights the latest SDK version and provides the npm install command.
 * https://patorjk.com/software/taag/
 *
 * These messages are intended to be logged to the console or shown in
 * terminal output so developers are aware of updates in a clear
 * and visually distinct way.
 *
 *
 */

import chalk from "chalk";
import boxen from "boxen";
import { mentraLogo_1, newUpdateText } from "./logos";

const createUpdateNotification = (versionNumb: string): string => {
  const line = chalk.bold.gray("-------------------------------");
  const logo = chalk.cyan(mentraLogo_1);
  const title = chalk.bold.cyan(newUpdateText);
  const versionMessage = `Version ${chalk.bold.cyan(`SDK VERSION V${versionNumb} is out! 🎉`)}`;
  const currentNote = chalk.yellow("You are running an older version");
  const instructions = chalk.yellow("Update to the latest version with:");
  const command = chalk.green.bold("bun install @mentra/sdk@latest");

  const content = [
    logo,
    title,
    line,
    versionMessage,
    currentNote,
    line,
    instructions,
    command,
  ].join("\n");

  return boxen(content, {
    padding: 1,
    margin: 1,
    borderStyle: "round",
    borderColor: "cyan",
    textAlignment: "left",
  });
};

export const newSDKUpdate = (versionNumb: string): string => {
  return createUpdateNotification(versionNumb);
};
