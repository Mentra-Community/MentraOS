import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { continuationGrantSchema, type ContinuationGrant } from "../types/test-continuation.types";
import { existingWorkGrantSchema, type ExistingWorkGrant } from "../types/test-existing-work.types";
import { testFailureOccurrenceIdSchema } from "../types/test-failure.types";

export function testFailureEnvironment(): "dev" | "staging" | "prod" | null {
  const value = process.env.CLOUD_CORE_ENVIRONMENT;
  if (value === "production") return "prod";
  return value === "dev" || value === "staging" || value === "prod" ? value : null;
}

export function signTestFailureDelivery(body: string, expires: number, secret: string): string {
  return createHmac("sha256", secret).update(`mentra-routine-failure-v1\n${expires}\n${body}`).digest("hex");
}

/** Same secret and transport as occurrence delivery, under its own purpose so neither body can stand in for the other. */
export function signTestFailureCorrectionDelivery(body: string, expires: number, secret: string): string {
  return createHmac("sha256", secret).update(`mentra-routine-failure-correction-v1\n${expires}\n${body}`).digest("hex");
}

const readGrantSchema = z.object({
  purpose: z.literal("mentra-test-failure-read-v1"),
  environment: z.enum(["dev", "staging", "prod"]), occurrenceId: testFailureOccurrenceIdSchema,
  expires: z.number().int().positive().safe(),
}).strict();

/** Controller-issued short-lived capability; never store it in cases or events. */
export function signTestFailureReadGrant(occurrenceId: string, environment: "dev" | "staging" | "prod", expires: number, secret: string): string {
  const grant = readGrantSchema.parse({ purpose: "mentra-test-failure-read-v1", environment, occurrenceId, expires });
  if (secret.length < 32) throw new Error("failure read signing is not configured");
  const encoded = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}

export function verifyTestFailureReadGrant(token: string, occurrenceId: string, secret: string, environment: string | null, now = Date.now()): boolean {
  if (secret.length < 32 || !environment || token.length > 2000) return false;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!)) return false;
  const expected = createHmac("sha256", secret).update(parts[0]!).digest();
  if (!timingSafeEqual(expected, Buffer.from(parts[1]!, "hex"))) return false;
  try {
    const grant = readGrantSchema.parse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
    const seconds = Math.floor(now / 1000);
    return grant.environment === environment && grant.occurrenceId === occurrenceId
      && grant.expires > seconds && grant.expires <= seconds + 15 * 60;
  } catch { return false; }
}

type ScopedGrant = { environment: string; occurrenceId: string; expires: number };
function signGrant<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, grant: T, secret: string, name: string): string {
  const value = schema.parse(grant);
  if (secret.length < 32) throw new Error(`${name} signing is not configured`);
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("hex")}`;
}
/** One HMAC envelope; each strict schema's purpose literal keeps grants from standing in for each other. */
function verifyGrant<T extends ScopedGrant>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, token: string, occurrenceId: string, secret: string,
  environment: string | null, now: number): T | null {
  if (secret.length < 32 || !environment || token.length > 4000) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!) || !/^[a-f0-9]{64}$/.test(parts[1]!)) return null;
  if (!timingSafeEqual(createHmac("sha256", secret).update(parts[0]!).digest(), Buffer.from(parts[1]!, "hex"))) return null;
  try {
    const grant = schema.parse(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
    const seconds = Math.floor(now / 1000);
    return grant.environment === environment && grant.occurrenceId === occurrenceId
      && grant.expires > seconds && grant.expires <= seconds + 15 * 60 ? grant : null;
  } catch { return null; }
}

export function signTestContinuationGrant(grant: ContinuationGrant, secret: string): string {
  return signGrant(continuationGrantSchema, grant, secret, "continuation");
}

export function verifyTestContinuationGrant(token: string, occurrenceId: string, secret: string,
  environment: string | null, now = Date.now()): ContinuationGrant | null {
  return verifyGrant(continuationGrantSchema, token, occurrenceId, secret, environment, now);
}

export function signTestExistingWorkGrant(grant: ExistingWorkGrant, secret: string): string {
  return signGrant(existingWorkGrantSchema, grant, secret, "existing-work");
}

export function verifyTestExistingWorkGrant(token: string, occurrenceId: string, secret: string,
  environment: string | null, now = Date.now()): ExistingWorkGrant | null {
  return verifyGrant(existingWorkGrantSchema, token, occurrenceId, secret, environment, now);
}
