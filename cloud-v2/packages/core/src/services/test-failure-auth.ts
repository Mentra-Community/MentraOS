import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { testFailureOccurrenceIdSchema } from "../types/test-failure.types";

export function testFailureEnvironment(): "dev" | "staging" | "prod" | null {
  const value = process.env.CLOUD_CORE_ENVIRONMENT;
  if (value === "production") return "prod";
  return value === "dev" || value === "staging" || value === "prod" ? value : null;
}

export function signTestFailureDelivery(body: string, expires: number, secret: string): string {
  return createHmac("sha256", secret).update(`mentra-routine-failure-v1\n${expires}\n${body}`).digest("hex");
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
