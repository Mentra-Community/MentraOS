/**
 * @fileoverview `cloud.core`: the device's stateless v2 REST calls.
 *
 * This is the simplest module: no live connection and no session state, so any
 * cloud pod can serve any call here. Each request goes through the shared HTTP
 * helper, which attaches the access token from `cloud.auth` as the Bearer, so
 * core never touches credentials itself.
 *
 * Today it exposes the miniapp lookups the device needs at launch plus the
 * unified report submission surface. It is meant to grow as miniapp-service and
 * other core resources are specced.
 *
 * Guardrail: this is device-facing only. It deliberately carries none of the
 * Dev Console / OEM Portal / store web UI surface; those are separate clients.
 *
 * See docs/issues/004-cloud-client/spec.md ("cloud.core") and design.md
 * ("src/modules/core/core.ts").
 */
import type { HttpClient } from "../../http";
import {
  Reports,
  type AddReportArtifactsResult,
  type ReportAttachmentInput,
  type ReportLogEntry,
  type ReportStatus,
  type SubmitReportInput,
  type SubmitReportResult,
} from "./reports";
import {
  SupportProfiles,
  type SupportProfileUpdateResult,
  type SupportStateInput,
} from "./support-profile";

export type {
  AddReportArtifactsResult,
  ReportAttachmentInput,
  ReportContext,
  ReportDetails,
  ReportKind,
  ReportLogEntry,
  ReportStatus,
  ReportSystemPriority,
  ReportTrigger,
  SubmitReportInput,
  SubmitReportResult,
} from "./reports";
export type {
  SupportConnectionState,
  SupportProfileUpdateResult,
  SupportStateInput,
} from "./support-profile";

/**
 * A single miniapp entry as returned by the listing.
 *
 * These shapes are owned by miniapp-service, which is not finalized yet, so they
 * are defined here against the spec rather than imported. They are intentionally
 * NOT taken from `@mentra/cloud-protocol`: that package is the live
 * session wire contract (subscriptions, transcripts, the message unions), while
 * a miniapp listing is a core REST resource with no place on the runtime wire.
 * When miniapp-service locks its schema, move these to the shared package and
 * import them here instead.
 */
export interface MiniappListing {
  /** The reverse-DNS identifier, for example "com.example.notes". */
  packageName: string;
  /** Human-readable name shown to the user. */
  name: string;
  /** The version offered to this user (the latest the user is entitled to). */
  version: string;
  /** Optional one-line summary for a launcher list. */
  description?: string;
  /** Optional icon URL for a launcher list. */
  iconUrl?: string;
}

/**
 * The manifest that ships inside a miniapp bundle.
 *
 * Same ownership note as `MiniappListing`: this is a miniapp-service shape,
 * defined here against the spec until that schema is locked. The fields below
 * are the minimum the device needs to identify and describe a fetched bundle;
 * miniapp-service is expected to add permission and capability declarations.
 */
export interface MiniappManifest {
  packageName: string;
  name: string;
  version: string;
  /** Optional permissions the miniapp declares it needs. */
  permissions?: string[];
}

/** What `getBundle` resolves to: where to download the bundle, plus its manifest. */
export interface MiniappBundle {
  /** A (typically signed, short-lived) URL the device downloads the bundle from. */
  downloadUrl: string;
  /** The concrete version resolved, important when the caller omitted `version`. */
  version: string;
  manifest: MiniappManifest;
}

export type PreinstalledInstallPolicy =
  | "install_once"
  | "keep_updated"
  | "mandatory";

export interface PreinstalledMiniappRegistryEntry {
  packageName: string;
  version: string;
  bundleUrl: string;
  bundleSha256: string;
  required: boolean;
  installPolicy: PreinstalledInstallPolicy;
  channel: string;
  minMobileVersion?: string;
  maxMobileVersion?: string;
  tenantId?: string;
}

export interface PreinstalledMiniappRegistry {
  generatedAt: string;
  entries: PreinstalledMiniappRegistryEntry[];
}

/** The dependencies `cloud.core` is wired with. */
export interface CoreDeps {
  http: HttpClient;
}

/**
 * `cloud.core`. Stateless REST grouped by resource (only `miniapps` so far).
 *
 * The grouping is exposed as a plain object so callers write
 * `cloud.core.miniapps.list()`, matching the public `CoreModule` contract in the
 * spec. Methods are bound in the constructor so destructuring `miniapps` keeps
 * working.
 */
export class Core {
  readonly miniapps: {
    list(): Promise<MiniappListing[]>;
    getBundle(packageName: string, version?: string): Promise<MiniappBundle>;
    getRegistry(opts?: { environment?: string }): Promise<PreinstalledMiniappRegistry>;
  };
  readonly reports: {
    submit(input: SubmitReportInput): Promise<SubmitReportResult>;
    addLogs(
      reportId: string,
      source: string,
      entries: ReportLogEntry[],
    ): Promise<AddReportArtifactsResult>;
    addScreenshots(
      reportId: string,
      images: ReportAttachmentInput[],
    ): Promise<AddReportArtifactsResult>;
    complete(reportId: string): Promise<{ status: ReportStatus }>;
  };
  readonly supportProfile: {
    update(input: SupportStateInput): Promise<SupportProfileUpdateResult>;
  };

  constructor(deps: CoreDeps) {
    const { http } = deps;
    const reports = new Reports({ http });
    const supportProfiles = new SupportProfiles(http);

    this.miniapps = {
      /**
       * List the miniapps available to the authenticated user.
       *
       * A GET so it is naturally safe to retry on a transient network error,
       * which the shared HTTP helper does for us.
       */
      list(): Promise<MiniappListing[]> {
        return http.get<MiniappListing[]>("/api/client/miniapps");
      },

      /**
       * Fetch the downloadable bundle for one miniapp.
       *
       * When `version` is omitted the cloud resolves the version the user is
       * entitled to (usually the latest); the resolved value comes back in the
       * response so the caller can record exactly what it got. The version is
       * passed as a query parameter and URL-encoded so an unusual version string
       * cannot break the path.
       */
      getBundle(packageName: string, version?: string): Promise<MiniappBundle> {
        const base = `/api/client/miniapps/${encodeURIComponent(packageName)}/bundle`;
        const path =
          version === undefined
            ? base
            : `${base}?version=${encodeURIComponent(version)}`;
        return http.get<MiniappBundle>(path);
      },

      /**
       * Fetch the admin-managed preinstalled miniapp registry for this device.
       *
       * The mobile client owns reconciliation: Core only returns the desired
       * bundle versions and install policy for the current user/OEM/channel.
       */
      getRegistry(opts?: { environment?: string }): Promise<PreinstalledMiniappRegistry> {
        const query = opts?.environment
          ? `?environment=${encodeURIComponent(opts.environment)}`
          : "";
        return http.get<PreinstalledMiniappRegistry>(`/api/client/miniapps/registry${query}`);
      },
    };
    this.reports = {
      submit: reports.submit.bind(reports),
      addLogs: reports.addLogs.bind(reports),
      addScreenshots: reports.addScreenshots.bind(reports),
      complete: reports.complete.bind(reports),
    };
    this.supportProfile = {
      update: supportProfiles.update.bind(supportProfiles),
    };
  }
}
