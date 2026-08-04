import crypto from "node:crypto";

const CORE = process.env.CORE_URL ?? "http://127.0.0.1:3000";
const secretValue = process.env.MENTRA_CORE_JWT_SECRET;
if (!secretValue) throw new Error("MENTRA_CORE_JWT_SECRET missing");

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64(JSON.stringify({
  sub: process.env.E2E_SUB ?? "preinstall-e2e-user",
  email: process.env.E2E_EMAIL ?? "isaiah@mentra.glass",
  iat: now,
  exp: now + 7200,
}));
const signed = `${header}.${payload}`;
const sig = crypto.createHmac("sha256", secretValue).update(signed).digest("base64url");
const coreToken = `${signed}.${sig}`;
console.log("[e2e] core token len:", coreToken.length);

const ex = await fetch(`${CORE}/api/client/auth/exchange`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: coreToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  }),
});
const exBody: any = await ex.json().catch(() => ({}));
console.log("[e2e] exchange:", ex.status, exBody.error ?? "ok", exBody.error_description ?? "");
const access = exBody.access_token;
if (!access) process.exit(1);
console.log("[e2e] access_token len:", access.length);
// stash for reuse
await Bun.write("/tmp/e2e-access-token.txt", access);

let bundleFailures = 0;
for (const env of ["debug", "dev", "staging", "prod"]) {
  const r = await fetch(`${CORE}/api/client/miniapps/registry?environment=${env}`, {
    headers: { authorization: `Bearer ${access}` },
  });
  const body: any = await r.json().catch(() => ({}));
  const entries = body.entries ?? body.miniapps ?? [];
  console.log(`[e2e] registry ${env}: ${r.status} entries=${entries.length}`);
  if (!r.ok) {
    console.error(
      `[e2e] registry ${env} failed: ${r.status} ${body.error ?? ""} ${body.error_description ?? ""}`.trim(),
    );
    process.exit(1);
  }

  // For the env we seeded, download each bundle and verify SHA-256 end to end.
  for (const entry of entries) {
    const url: string = entry.bundleUrl ?? entry.downloadUrl ?? entry.url;
    const expected: string = entry.bundleSha256 ?? entry.sha256 ?? "";
    if (!url) {
      console.log(`  - ${entry.packageName ?? "?"} v${entry.version ?? "?"}: NO bundleUrl, entry=${JSON.stringify(entry).slice(0, 300)}`);
      continue;
    }
    const abs = url.startsWith("http") ? url : `${CORE}${url}`;
    const dl = await fetch(abs, { headers: { authorization: `Bearer ${access}` } });
    const buf = Buffer.from(await dl.arrayBuffer());
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    const hdr = dl.headers.get("x-bundle-sha256") ?? "";
    const ok = got === expected;
    console.log(
      `  - ${entry.packageName} v${entry.version} policy=${entry.installPolicy ?? "?"}: ` +
      `dl=${dl.status} bytes=${buf.length} sha_ok=${ok} (got=${got.slice(0, 12)} expect=${expected.slice(0, 12)} hdr=${hdr.slice(0, 12)})`,
    );
    // A corrupted or failed download must fail the e2e run, not just log.
    if (!dl.ok) {
      console.error(`  - ${entry.packageName} v${entry.version}: download failed (status ${dl.status})`);
      bundleFailures++;
    } else if (!expected || !ok) {
      console.error(
        `  - ${entry.packageName} v${entry.version}: SHA-256 mismatch (got=${got.slice(0, 12)} expect=${expected.slice(0, 12) || "<none>"})`,
      );
      bundleFailures++;
    }
  }
}

if (bundleFailures > 0) {
  console.error(`[e2e] ${bundleFailures} bundle integrity failure(s)`);
  process.exit(1);
}
