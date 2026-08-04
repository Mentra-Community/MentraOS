/**
 * `@mentra/test-oem` — reference OEM implementation. Used by integration
 * tests and as a hand-runnable fixture for local exploration of the OEM
 * auth flow.
 *
 * Configuration via env (only consulted when run as a main module):
 *   TEST_OEM_ID           — value used as `iss`. Default `"test-oem"`.
 *   TEST_OEM_PORT         — listen port. Default `3100`.
 *   TEST_OEM_PRIVATE_KEY  — base64 body of PKCS#8 Ed25519 private key.
 *
 * Programmatic boot: `startTestOem({ port, tenantId })` — used by integration
 * tests so they can drive the OEM-side of the handshake in-process.
 *
 * Spec: docs/issues/001-oem-auth/design.md ("TEST OEM")
 */

import { loadKeypair, type TestOemKeypair } from "./keypair";
import { createTestOemApp } from "./app";

export interface StartTestOemOptions {
  /** Listen port. Default: env or `3100`. */
  port?: number;
  /** Value used as `iss`. Default: env or `"test-oem"`. */
  tenantId?: string;
}

export interface TestOemHandle {
  port: number;
  url: string;
  tenantId: string;
  /** Loaded or freshly-generated keypair. `publicKeyBody` is paste-ready for `oems.publicKey`. */
  keypair: TestOemKeypair;
  stop(): Promise<void>;
}

export async function startTestOem(
  opts: StartTestOemOptions = {},
): Promise<TestOemHandle> {
  const tenantId = opts.tenantId ?? process.env.TEST_OEM_ID ?? "test-oem";
  const port =
    opts.port ?? Number.parseInt(process.env.TEST_OEM_PORT ?? "3100", 10);

  const keypair = await loadKeypair({ kid: `${tenantId}-key-1` });
  const app = createTestOemApp({ tenantId, keypair });
  const server = Bun.serve({ port, fetch: app.fetch });
  const boundPort = server.port!;

  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    tenantId,
    keypair,
    async stop() {
      server.stop();
    },
  };
}

if (import.meta.main) {
  const handle = await startTestOem();
  console.log(
    `[test-oem] listening on :${handle.port} as tenantId=${handle.tenantId}`,
  );
  console.log(
    `[test-oem] JWKS: ${handle.url}/.well-known/jwks.json`,
  );
}
