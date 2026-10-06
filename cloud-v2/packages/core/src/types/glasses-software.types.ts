import {z} from "zod";

const positive = z.number().int().positive().safe();
export const firmwareManifestSchema = z.object({url: z.string().url().refine(value => {
  try {const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !value.includes("#");}
  catch {return false;}
}, "Firmware manifest requires an HTTPS URL without credentials or fragment"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), size: positive}).strict();
export const glassesSoftwareRefSchema = z.object({model: z.literal("mentra-live"), manifest: firmwareManifestSchema}).strict();
export type GlassesSoftwareRef = z.infer<typeof glassesSoftwareRefSchema>;
