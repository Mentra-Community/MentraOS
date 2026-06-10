#!/usr/bin/env bun
/**
 * Phone-driven audio fault harness.
 *
 * This script automates the repeatable parts of the Local Captions E2E checks:
 * preflight, logcat capture, laptop TTS markers, fault injection hooks, and
 * screenshots. It intentionally leaves visual transcript-history assertions as
 * explicit pass criteria in the artifact notes until we have app-side telemetry
 * or OCR wired in.
 *
 * Examples:
 *   bun scripts/audio-fault-e2e.ts preflight --target local --host 10.0.0.5
 *   bun scripts/audio-fault-e2e.ts cloud-down-up --target local --host 10.0.0.5
 *   bun scripts/audio-fault-e2e.ts cloud-down-up --target porter \
 *     --core-url https://core.dev.example.com \
 *     --runtime-url https://runtime.dev.example.com \
 *     --down-command 'porter app stop mentra-runtime-dev' \
 *     --up-command 'porter app start mentra-runtime-dev'
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Target = "local" | "porter";
type Scenario = "preflight" | "cloud-down-up" | "cloud-starts-late";

interface Config {
  scenario: Scenario;
  target: Target;
  serial?: string;
  appId: string;
  host: string;
  coreUrl: string;
  corePort: number;
  runtimeUrl: string;
  miniappUrl: string;
  miniappPort: number;
  launchUrl?: string;
  artifactDir: string;
  onlineMarkerA: string;
  offlineMarkerB: string;
  onlineMarkerC: string;
  secondsAfterSpeech: number;
  secondsAfterFault: number;
  secondsAfterRecovery: number;
  runtimePort: number;
  audioUdpPort: number;
  testOemPort: number;
  adbReverse: boolean;
  manageLocalCloud: boolean;
  keepManagedCloud: boolean;
  localStartCommand?: string;
  downCommand?: string;
  upCommand?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const CLOUD_V2_ROOT = new URL("..", import.meta.url).pathname;
const DEFAULT_APP_ID = "com.mentra.mentra";
const DEFAULT_MINIAPP_PORT = 3100;
const DEFAULT_CORE_PORT = 3000;
const DEFAULT_RUNTIME_PORT = 3001;
const DEFAULT_AUDIO_UDP_PORT = 8000;
const DEFAULT_TEST_OEM_PORT = 3102;

const config = await loadConfig();
mkdirSync(config.artifactDir, { recursive: true });

const phaseLogPath = join(config.artifactDir, "run.md");
let managedCloud: ReturnType<typeof Bun.spawn> | null = null;
let logcat: ReturnType<typeof Bun.spawn> | null = null;

writeFileSync(phaseLogPath, "");
writePhase(`# Audio fault E2E run\n`);
writePhase(`- scenario: ${config.scenario}`);
writePhase(`- target: ${config.target}`);
writePhase(`- appId: ${config.appId}`);
writePhase(`- host: ${config.host}`);
writePhase(`- coreUrl: ${config.coreUrl}`);
writePhase(`- runtimeUrl: ${config.runtimeUrl}`);
writePhase(`- miniappUrl: ${config.miniappUrl}`);
writePhase(`- artifactDir: ${config.artifactDir}\n`);

process.on("SIGINT", () => {
  void cleanup().finally(() => process.exit(130));
});
process.on("SIGTERM", () => {
  void cleanup().finally(() => process.exit(143));
});

try {
  await runScenario(config);
  await cleanup();
  writePhase("\n## Result\nHarness completed. Apply the pass criteria in this file to the screenshots and logs.");
  console.log(`\n[audio-fault] artifacts: ${config.artifactDir}`);
} catch (err) {
  writePhase(`\n## Failure\n${formatError(err)}`);
  await cleanup();
  console.error(`[audio-fault] failed: ${formatError(err)}`);
  console.error(`[audio-fault] artifacts: ${config.artifactDir}`);
  process.exit(1);
}

async function runScenario(cfg: Config): Promise<void> {
  await preflight(cfg);
  if (cfg.scenario === "preflight") return;

  logcat = await startLogcat(cfg);

  if (cfg.launchUrl) {
    const launchUrl = cfg.launchUrl;
    await phase("launch app/deep link", async () => {
      await adb(cfg, ["shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", launchUrl]);
      await sleep(3000);
      await screenshot(cfg, "00-launched");
    });
  } else {
    writePhase("## Launch\nNo --launch-url supplied. Navigate the phone to Local Captions before the speech phases.\n");
    await screenshot(cfg, "00-before-markers");
  }

  if (cfg.scenario === "cloud-starts-late") {
    await injectDown(cfg);
    await waitAfterFault(cfg);
    await speakAndCapture(cfg, "offline-first", cfg.offlineMarkerB);
    await injectUp(cfg);
    await waitAfterRecovery(cfg);
    await speakAndCapture(cfg, "online-after-late-start", cfg.onlineMarkerC);
    writePassCriteria([
      "Offline-first marker appears while cloud is unavailable.",
      "After cloud starts, a cloud transcript appears without restarting the app.",
      "The offline final card is not duplicated or rewritten by the online result.",
    ]);
    return;
  }

  await speakAndCapture(cfg, "online-a", cfg.onlineMarkerA);
  await injectDown(cfg);
  await waitAfterFault(cfg);
  await speakAndCapture(cfg, "offline-b", cfg.offlineMarkerB);
  await injectUp(cfg);
  await waitAfterRecovery(cfg);
  await speakAndCapture(cfg, "online-c", cfg.onlineMarkerC);
  writePassCriteria([
    "Online marker A, offline marker B, and online marker C are all visible as separate final entries.",
    "Offline marker B appears exactly once.",
    "Online marker C appends after B; it does not replace marker A or B.",
    "Logs show cloud down/up state transitions and subscription recovery.",
  ]);
}

async function preflight(cfg: Config): Promise<void> {
  await phase("preflight", async () => {
    const adbDevices = await run("adb", ["devices"]);
    writeArtifact("adb-devices.txt", adbDevices.stdout);
    if (!adbDevices.stdout.includes("\tdevice")) {
      throw new Error("no adb device is connected and authorized");
    }

    if (cfg.adbReverse) {
      for (const port of [8081, cfg.miniappPort, cfg.miniappPort + 1, cfg.runtimePort, cfg.corePort].filter(isFiniteNumber)) {
        await adb(cfg, ["reverse", `tcp:${port}`, `tcp:${port}`], { allowFailure: true });
      }
    }

    const appState = await adb(cfg, ["shell", "pm", "path", cfg.appId], { allowFailure: true });
    writeArtifact("app-package.txt", appState.stdout + appState.stderr);
    if (appState.code !== 0) {
      throw new Error(`Android package ${cfg.appId} is not installed`);
    }

    const cloudMustBeUp = cfg.scenario !== "cloud-starts-late";
    await checkHttp("core health", `${cfg.coreUrl}/healthz`, cloudMustBeUp);
    await checkHttp("runtime health", `${cfg.runtimeUrl}/healthz`, cloudMustBeUp);
    await checkHttp("Local Captions miniapp", `${cfg.miniappUrl}/miniapp.json`, false);
  });
}

async function speakAndCapture(cfg: Config, label: string, marker: string): Promise<void> {
  await phase(`speak ${label}`, async () => {
    writePhase(`Marker: \`${marker}\``);
    await speak(marker);
    await sleep(cfg.secondsAfterSpeech * 1000);
    await screenshot(cfg, label);
  });
}

async function injectDown(cfg: Config): Promise<void> {
  await phase("inject cloud down", async () => {
    const command = cfg.downCommand ?? defaultDownCommand(cfg);
    if (!command) {
      throw new Error("no down command configured for this target");
    }
    await shell(command, { cwd: CLOUD_V2_ROOT });
  });
}

async function injectUp(cfg: Config): Promise<void> {
  await phase("restore cloud", async () => {
    const command = cfg.upCommand ?? defaultUpCommand(cfg);
    if (!command) {
      throw new Error("no up command configured for this target");
    }

    if (cfg.target === "local" && cfg.manageLocalCloud && cfg.keepManagedCloud) {
      const stdoutPath = shellQuote(join(cfg.artifactDir, "managed-cloud.stdout.log"));
      const stderrPath = shellQuote(join(cfg.artifactDir, "managed-cloud.stderr.log"));
      managedCloud = Bun.spawn(
        ["bash", "-lc", `${command} >> ${stdoutPath} 2>> ${stderrPath}`],
        {
          cwd: CLOUD_V2_ROOT,
          env: process.env as Record<string, string>,
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      managedCloud.unref();
    } else if (cfg.target === "local" && cfg.manageLocalCloud) {
      managedCloud = Bun.spawn(["bash", "-lc", command], {
        cwd: CLOUD_V2_ROOT,
        env: process.env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
      });
      void pipeToArtifact(
        managedCloud.stdout as ReadableStream<Uint8Array> | null,
        "managed-cloud.stdout.log",
      );
      void pipeToArtifact(
        managedCloud.stderr as ReadableStream<Uint8Array> | null,
        "managed-cloud.stderr.log",
      );
    } else {
      await shell(command, { cwd: CLOUD_V2_ROOT });
    }

    await waitForHttp(`${cfg.coreUrl}/healthz`, 30_000);
    await waitForHttp(`${cfg.runtimeUrl}/healthz`, 30_000);
  });
}

async function waitAfterFault(cfg: Config): Promise<void> {
  await phase("wait after fault", async () => {
    await sleep(cfg.secondsAfterFault * 1000);
    await screenshot(cfg, "after-fault");
  });
}

async function waitAfterRecovery(cfg: Config): Promise<void> {
  await phase("wait after recovery", async () => {
    await sleep(cfg.secondsAfterRecovery * 1000);
    await screenshot(cfg, "after-recovery");
  });
}

async function startLogcat(cfg: Config): Promise<ReturnType<typeof Bun.spawn>> {
  await adb(cfg, ["logcat", "-c"], { allowFailure: true });
  const proc = Bun.spawn(
    ["adb", ...adbSerialArgs(cfg), "logcat", "-v", "time"],
    { stdout: "pipe", stderr: "pipe" },
  );
  void pipeToArtifact(proc.stdout, "logcat.log");
  void pipeToArtifact(proc.stderr, "logcat.stderr.log");
  writePhase("## Logcat\nCapturing full logcat to `logcat.log`.\n");
  return proc;
}

async function screenshot(cfg: Config, label: string): Promise<void> {
  const path = join(cfg.artifactDir, `${Date.now()}-${label}.png`);
  const proc = Bun.spawn(["adb", ...adbSerialArgs(cfg), "exec-out", "screencap", "-p"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).arrayBuffer();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    writePhase(`Screenshot failed for ${label}: ${err.trim()}`);
    return;
  }
  await Bun.write(path, out);
  writePhase(`Screenshot: ${path}`);
}

async function speak(text: string): Promise<void> {
  if (process.platform !== "darwin") {
    writePhase(`Manual speech required: ${text}`);
    console.log(`[audio-fault] say: ${text}`);
    return;
  }
  await run("say", [text]);
}

async function cleanup(): Promise<void> {
  if (logcat) {
    logcat.kill("SIGTERM");
    await logcat.exited.catch(() => undefined);
    logcat = null;
  }
  if (managedCloud && !config.keepManagedCloud) {
    managedCloud.kill("SIGTERM");
    await managedCloud.exited.catch(() => undefined);
    managedCloud = null;
  }
}

async function phase(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`[audio-fault] ${name}`);
  writePhase(`\n## ${name}\n`);
  const started = Date.now();
  await fn();
  writePhase(`Completed in ${Date.now() - started}ms.\n`);
}

function writePassCriteria(criteria: string[]): void {
  writePhase("\n## Pass Criteria\n");
  for (const item of criteria) writePhase(`- ${item}`);
}

function defaultDownCommand(cfg: Config): string | undefined {
  if (cfg.target !== "local") return undefined;
  return `pids=$(lsof -ti tcp:${cfg.runtimePort} || true); if [ -n "$pids" ]; then kill -TERM $pids; fi`;
}

function defaultUpCommand(cfg: Config): string | undefined {
  if (cfg.upCommand) return cfg.upCommand;
  if (cfg.target !== "local") return undefined;
  if (cfg.localStartCommand) return cfg.localStartCommand;
  if (!cfg.manageLocalCloud) return undefined;
  return [
    "doppler run -- env",
    `MONGO_URL=${shellQuote(process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/cloud-v2-phone-e2e")}`,
    `REDIS_URL=${shellQuote(process.env.REDIS_URL ?? "redis://127.0.0.1:6379/7")}`,
    `AUDIO_PROVIDER=${shellQuote(process.env.AUDIO_PROVIDER ?? "soniox")}`,
    `DEV_CORE_PORT=${cfg.corePort}`,
    `DEV_RUNTIME_HTTP_PORT=${cfg.runtimePort}`,
    `DEV_RUNTIME_UDP_PORT=${cfg.audioUdpPort}`,
    `DEV_TEST_OEM_PORT=${cfg.testOemPort}`,
    `DEV_UDP_ADVERTISE_HOST=${shellQuote(cfg.host)}`,
    "bun scripts/dev-stack.ts",
  ].join(" ");
}

async function checkHttp(name: string, url: string, required: boolean): Promise<void> {
  try {
    await waitForHttp(url, 2500);
    writePhase(`- ${name}: OK (${url})`);
  } catch (err) {
    writePhase(`- ${name}: FAIL (${url}) ${formatError(err)}`);
    if (required) throw err;
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return;
      lastError = `${res.status} ${await res.text().catch(() => "")}`;
    } catch (err) {
      lastError = formatError(err);
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

async function adb(
  cfg: Config,
  args: string[],
  opts: { allowFailure?: boolean } = {},
): Promise<RunResult> {
  const result = await run("adb", [...adbSerialArgs(cfg), ...args], { allowFailure: opts.allowFailure });
  writePhase(`adb ${args.join(" ")} -> ${result.code}`);
  return result;
}

function adbSerialArgs(cfg: Config): string[] {
  return cfg.serial ? ["-s", cfg.serial] : [];
}

async function shell(
  command: string,
  opts: { cwd?: string; allowFailure?: boolean } = {},
): Promise<RunResult> {
  writePhase(`Command: \`${command}\``);
  return run("bash", ["-lc", command], opts);
}

async function run(
  command: string,
  args: string[],
  opts: { cwd?: string; allowFailure?: boolean } = {},
): Promise<RunResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const result = { code, stdout, stderr };
  if (code !== 0 && !opts.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`);
  }
  return result;
}

async function pipeToArtifact(
  stream: ReadableStream<Uint8Array> | null,
  filename: string,
): Promise<void> {
  if (!stream) return;
  const path = join(config.artifactDir, filename);
  const file = Bun.file(path);
  const writer = file.writer();
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(value);
    }
  } finally {
    writer.end();
  }
}

function writeArtifact(filename: string, body: string): void {
  writeFileSync(join(config.artifactDir, filename), body);
}

function writePhase(line: string): void {
  const suffix = line.endsWith("\n") ? "" : "\n";
  appendFileSync(phaseLogPath, `${line}${suffix}`);
}

function shellQuote(value: string | number): string {
  const s = String(value);
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

async function loadConfig(): Promise<Config> {
  const args = parseArgs(Bun.argv.slice(2));
  const scenario = normalizeScenario(args._[0] ?? "cloud-down-up");
  const target = normalizeTarget(args.target ?? process.env.MENTRA_FAULT_TARGET ?? "local");
  const host = args.host ?? process.env.MENTRA_FAULT_HOST ?? (await detectHostIp()) ?? "127.0.0.1";
  const runtimePort = numberArg(args["runtime-port"], DEFAULT_RUNTIME_PORT);
  const corePort = numberArg(args["core-port"], DEFAULT_CORE_PORT);
  const miniappPort = numberArg(args["miniapp-port"], DEFAULT_MINIAPP_PORT);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = resolve(
    args.artifacts ??
      process.env.MENTRA_FAULT_ARTIFACTS ??
      `/tmp/mentra-audio-faults/${timestamp}-${scenario}-${target}`,
  );
  const coreUrl = trimSlash(
    args["core-url"] ??
      process.env.MENTRA_FAULT_CORE_URL ??
      `http://${host}:${corePort}`,
  );
  const runtimeUrl = trimSlash(
    args["runtime-url"] ??
      process.env.MENTRA_FAULT_RUNTIME_URL ??
      `http://${host}:${runtimePort}`,
  );
  const miniappUrl = trimSlash(
    args["miniapp-url"] ??
      process.env.MENTRA_FAULT_MINIAPP_URL ??
      `http://${host}:${miniappPort}`,
  );

  const cfg: Config = {
    scenario,
    target,
    serial: args.serial ?? process.env.ANDROID_SERIAL,
    appId: args["app-id"] ?? process.env.MENTRA_FAULT_APP_ID ?? DEFAULT_APP_ID,
    host,
    coreUrl,
    corePort,
    runtimeUrl,
    miniappUrl,
    miniappPort,
    launchUrl: args["launch-url"] ?? process.env.MENTRA_FAULT_LAUNCH_URL,
    artifactDir,
    onlineMarkerA: args["online-a"] ?? "maple orbit",
    offlineMarkerB: args["offline-b"] ?? "quartz meadow",
    onlineMarkerC: args["online-c"] ?? "silver garden",
    secondsAfterSpeech: numberArg(args["speech-wait"], 10),
    secondsAfterFault: numberArg(args["fault-wait"], 10),
    secondsAfterRecovery: numberArg(args["recovery-wait"], 18),
    runtimePort,
    audioUdpPort: numberArg(args["audio-udp-port"], DEFAULT_AUDIO_UDP_PORT),
    testOemPort: numberArg(args["test-oem-port"], DEFAULT_TEST_OEM_PORT),
    adbReverse: boolArg(args["adb-reverse"], true),
    manageLocalCloud: boolArg(args["manage-local-cloud"], target === "local"),
    keepManagedCloud: boolArg(args["keep-managed-cloud"], true),
    localStartCommand: args["local-start-command"] ?? process.env.MENTRA_FAULT_LOCAL_START_CMD,
    downCommand: args["down-command"] ?? process.env.MENTRA_FAULT_DOWN_CMD,
    upCommand: args["up-command"] ?? process.env.MENTRA_FAULT_UP_CMD,
  };

  return cfg;
}

function parseArgs(argv: string[]): Record<string, string | undefined> & { _: string[] } {
  const out = { _: [] as string[] } as unknown as Record<
    string,
    string | undefined
  > & { _: string[] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function normalizeScenario(value: string): Scenario {
  if (value === "preflight" || value === "cloud-down-up" || value === "cloud-starts-late") {
    return value;
  }
  throw new Error(`unknown scenario ${value}`);
}

function normalizeTarget(value: string): Target {
  if (value === "local" || value === "porter") return value;
  throw new Error(`unknown target ${value}`);
}

function numberArg(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`expected number, got ${value}`);
  return parsed;
}

function boolArg(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function detectHostIp(): Promise<string | null> {
  for (const iface of ["en0", "en1"]) {
    const result = await run("ipconfig", ["getifaddr", iface], { allowFailure: true });
    const ip = result.stdout.trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  }
  return null;
}
