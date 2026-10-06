import type { Command } from "commander";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  createPublishingToken,
  createWorkspaceCredential,
  deleteListingAsset,
  getListing,
  listWorkspaceCredentials,
  publishRelease,
  resolveWorkspaceId,
  reviewRelease,
  revokeWorkspaceCredential,
  updateListing,
  uploadListingAsset,
  type StoreAsset,
  type StoreListingInput,
} from "./api";
import type { CliCredentials } from "./credentials";

export function registerStoreCommands(program: Command, requireCredentials: () => Promise<CliCredentials | null>) {
  const run =
    (action: (creds: CliCredentials, ...args: any[]) => Promise<void>) =>
    async (...args: any[]) => {
      try {
        const creds = await requireCredentials();
        if (creds) await action(creds, ...args);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    };
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  const listing = program
    .command("listing")
    .description("Manage Store descriptions, links, and artwork without the Developer Console");
  listing
    .command("show <packageName>")
    .action(run(async (creds, packageName) => print(await getListing(creds, packageName))));
  listing
    .command("update <packageName>")
    .requiredOption("--file <path>", "JSON file containing the listing fields to update")
    .action(
      run(async (creds, packageName, options) => {
        const input = parseListingInput(JSON.parse(readFileSync(options.file, "utf8")));
        print(await updateListing(creds, packageName, input));
      }),
    );
  const assets = listing.command("assets").description("Upload or remove Store artwork");
  assets
    .command("upload <packageName> <path>")
    .requiredOption("--role <role>", "store_icon, store_cover, or gallery_screenshot")
    .option("--skip-existing", "skip artwork that is already selected and has identical bytes")
    .action(
      run(async (creds, packageName, path, options) => {
        if (!["store_icon", "store_cover", "gallery_screenshot"].includes(options.role))
          throw new Error("Invalid artwork role");
        const role = options.role as StoreAsset["role"];
        const contentType = (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".avif": "image/avif",
          } as Record<string, string>
        )[extname(path).toLowerCase()];
        if (!contentType) throw new Error("Artwork must be PNG, JPEG, WebP, or AVIF");
        const bytes = readFileSync(path);
        if (bytes.length > 10 * 1024 * 1024) throw new Error("Artwork exceeds the 10 MB limit");
        if (options.skipExisting) {
          const { listing } = await getListing(creds, packageName);
          const ids =
            role === "store_icon"
              ? [listing.iconAssetId]
              : role === "store_cover"
                ? [listing.coverAssetId]
                : listing.screenshotAssetIds;
          const hash = createHash("sha256").update(bytes).digest("hex");
          const existing = listing.assets.find(
            (asset) => ids.includes(asset.id) && asset.role === role && asset.sha256 === hash,
          );
          if (existing) {
            print({ asset: existing, skipped: true });
            return;
          }
        }
        print(
          await uploadListingAsset(creds, packageName, {
            role,
            fileName: basename(path),
            contentType,
            base64: bytes.toString("base64"),
          }),
        );
      }),
    );
  assets
    .command("remove <packageName> <assetId>")
    .action(run(async (creds, packageName, assetId) => print(await deleteListingAsset(creds, packageName, assetId))));

  const releases = program.commands.find((command) => command.name() === "releases")!;
  releases
    .command("publish <packageName> <releaseId>")
    .description("Publish an approved release; app publishing tokens may approve automatically")
    .action(run(async (creds, packageName, releaseId) => print(await publishRelease(creds, packageName, releaseId))));
  const admin = program.commands.find((command) => command.name() === "admin")!;
  for (const action of ["approve", "reject", "publish"] as const) {
    admin
      .command(`${action} <releaseId>`)
      .description(`Store administrator: ${action} a release`)
      .option("--notes <text>", "review notes")
      .action(
        run(async (creds, releaseId, options) => print(await reviewRelease(creds, releaseId, action, options.notes))),
      );
  }
  admin
    .command("publishing-token <packageName>")
    .description("Grant CI permission to manage and automatically publish only this miniapp")
    .requiredOption("--name <name>", "name identifying this CI credential")
    .requiredOption("--output <path>", "write the secret to a new private file (never stdout)")
    .action(
      run(async (creds, packageName, options) => {
        const token = await writeTokenFile(
          options.output,
          async () => (await createPublishingToken(creds, packageName, options.name)).token,
        );
        print({ id: token.id, permissions: token.permissions, secretFile: options.output });
      }),
    );
  const tokens = program.command("tokens").description("Manage the active workspace's miniapp publishing credentials");
  tokens.command("list").action(
    run(async (creds) => {
      const workspaceId = await resolveWorkspaceId(creds);
      print(await listWorkspaceCredentials({ ...creds, workspaceId }, workspaceId));
    }),
  );
  tokens
    .command("create")
    .requiredOption("--name <name>", "credential name")
    .option("--package <packageName>", "restrict the credential to this miniapp package (repeatable)", collect)
    .option("--expires <date>", "ISO 8601 date after which the credential stops working")
    .requiredOption("--output <path>", "write the secret to a new private file")
    .action(
      run(async (creds, options) => {
        const expiresAt = parseExpiry(options.expires);
        const workspaceId = await resolveWorkspaceId(creds);
        const input = {
          name: options.name as string,
          ...(options.package ? { packageNames: options.package as string[] } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        };
        const { credential } = await writeTokenFile(options.output, async () => {
          const created = await createWorkspaceCredential({ ...creds, workspaceId }, workspaceId, input);
          return { ...created, value: created.token };
        });
        print({
          credentialId: credential.credentialId,
          name: credential.name,
          display: credential.display,
          packageNames: credential.packageNames,
          expiresAt: credential.expiresAt,
          secretFile: options.output,
        });
      }),
    );
  tokens.command("revoke <credentialId>").action(
    run(async (creds, credentialId) => {
      const workspaceId = await resolveWorkspaceId(creds);
      await revokeWorkspaceCredential({ ...creds, workspaceId }, workspaceId, credentialId);
      print({ ok: true, credentialId });
    }),
  );
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** An ISO 8601 date or date-time as the UTC ISO string Core expects, checked before anything is reserved or minted. */
function parseExpiry(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const time = ISO_DATE.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(time)) throw new Error("--expires must be an ISO 8601 date, e.g. 2030-01-01T00:00:00Z");
  return new Date(time).toISOString();
}

async function writeTokenFile<T extends { value: string }>(path: string, issue: () => Promise<T>): Promise<T> {
  // Reserve before minting and keep the file descriptor so a later path change
  // cannot redirect the secret. Failed requests must not leave an empty file
  // that prevents the same command from being retried.
  const fd = openSync(path, "wx", 0o600);
  let written = false;
  try {
    const token = await issue();
    writeFileSync(fd, `${token.value}\n`);
    written = true;
    return token;
  } finally {
    closeSync(fd);
    if (!written) rmSync(path, { force: true });
  }
}

export function parseListingInput(value: unknown): StoreListingInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Listing file must be a JSON object");
  const input = value as Record<string, unknown>;
  const textFields = ["subtitle", "longDescription", "privacyPolicyUrl", "supportUrl", "websiteUrl"];
  for (const [key, field] of Object.entries(input)) {
    if (key === "categories") {
      if (!Array.isArray(field) || !field.every((category) => typeof category === "string"))
        throw new Error("categories must be an array of strings");
    } else if (!textFields.includes(key) || (field !== null && typeof field !== "string")) {
      throw new Error(`Invalid listing field: ${key}`);
    }
  }
  return input as StoreListingInput;
}
