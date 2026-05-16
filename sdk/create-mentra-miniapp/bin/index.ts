#!/usr/bin/env bun

import * as fs from 'fs';
import * as path from 'path';
import { intro, outro, text, select, isCancel, cancel, note } from '@clack/prompts';

type GlassesType = 'display' | 'camera';

interface CliFlags {
  projectName?: string;
  type?: GlassesType;
}

function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {};
  for (const arg of argv) {
    if (arg.startsWith('--type=')) {
      const value = arg.slice('--type='.length);
      if (value === 'display' || value === 'camera') {
        flags.type = value;
      } else {
        console.error(`Invalid --type value: "${value}". Expected "display" or "camera".`);
        process.exit(1);
      }
    } else if (!arg.startsWith('-') && !flags.projectName) {
      flags.projectName = arg;
    }
  }
  return flags;
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function validateProjectName(name: string): string | undefined {
  if (!name.trim()) return 'Project name is required';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-_ ]*$/.test(name)) {
    return 'Use letters, numbers, dashes, underscores, or spaces (cannot start with a symbol)';
  }
  if (fs.existsSync(path.resolve(process.cwd(), name))) {
    return `Directory "${name}" already exists`;
  }
  return undefined;
}

function bailIfCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  return value as T;
}

const flags = parseArgs(process.argv.slice(2));

intro('create-mentra-miniapp');

let projectName = flags.projectName;
if (projectName) {
  const err = validateProjectName(projectName);
  if (err) {
    cancel(err);
    process.exit(1);
  }
} else {
  projectName = bailIfCancelled(
    await text({
      message: "What's your project name?",
      placeholder: 'my-miniapp',
      validate: validateProjectName,
    }),
  );
}

let glassesType = flags.type;
if (!glassesType) {
  glassesType = bailIfCancelled(
    await select<GlassesType>({
      message: 'What kind of glasses is this miniapp for?',
      options: [
        {
          value: 'display',
          label: 'Display glasses',
          hint: 'Even Realities G1/G2, Vuzix Z100',
        },
        {
          value: 'camera',
          label: 'Camera glasses',
          hint: 'Mentra Live',
        },
      ],
    }),
  );
}

const targetDir = path.resolve(process.cwd(), projectName);
const templateDir = path.resolve(import.meta.dirname, '..', 'template');

const kebabName = toKebabCase(projectName);
const packageName = `com.mentra.${kebabName}`;
const hardwareRequirements =
  glassesType === 'camera'
    ? [
        { type: 'CAMERA', level: 'REQUIRED' },
        { type: 'MICROPHONE', level: 'REQUIRED' },
      ]
    : [
        { type: 'DISPLAY', level: 'REQUIRED' },
        { type: 'MICROPHONE', level: 'REQUIRED' },
      ];

function renderFile(srcPath: string, destPath: string): void {
  if (path.basename(srcPath) === 'miniapp.json') {
    const raw = fs.readFileSync(srcPath, 'utf-8');
    const manifest = JSON.parse(raw.replace(/\{\{packageName\}\}/g, packageName));
    manifest.hardwareRequirements = hardwareRequirements;
    fs.writeFileSync(destPath, JSON.stringify(manifest, null, 2) + '\n');
    return;
  }

  const content = fs.readFileSync(srcPath, 'utf-8').replace(/\{\{packageName\}\}/g, packageName);
  fs.writeFileSync(destPath, content);
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    // npm strips literal `.gitignore` files on publish; the template
    // ships it as `_gitignore` instead and we rename on copy so the
    // scaffolded project starts with a proper `.gitignore`.
    const renamed = entry.name === '_gitignore' ? '.gitignore' : entry.name;
    const destPath = path.join(dest, renamed);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      renderFile(srcPath, destPath);
    }
  }
}

copyDir(templateDir, targetDir);

note(
  `cd ${projectName}\nbun install\nbun dev`,
  'Next steps',
);

outro(`Created miniapp in ./${projectName}`);
