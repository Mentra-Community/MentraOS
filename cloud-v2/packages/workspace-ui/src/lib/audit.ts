/**
 * Audit events in words.
 *
 * Each event becomes one sentence about what happened and to whom ("Invited jamie@acme.test as
 * Member"), without who did it: the panel names the actor beside it. Roles are capitalised, dates
 * formatted, lists written out, and internal ids left out. Events recorded before Core named their
 * subject (no `target.email`) still read sensibly ("Revoked an invitation (Member)"). An action this UI
 * does not know shows its readable changes instead.
 */

import { OWNS_MINIAPPS_HOLD_REASON, WORKSPACE_ROLES, type AuditEventView, type WorkspaceRole } from "@mentra/workspace-contract";
import { ROLE_LABELS } from "../roles";
import { formatDate, formatDateTime } from "./format";

/** A sentence in runs; `strong` marks the names in it (people, workspaces, keys, roles). */
export type AuditText = Array<string | { strong: string }>;

export interface AuditDescription {
  summary: AuditText;
  /** Further facts, one short sentence each. */
  notes: string[];
}

type Snapshot = Record<string, unknown>;

const ACTION_LABELS: Record<string, string> = {
  "workspace.created": "Workspace created",
  "workspace.renamed": "Workspace renamed",
  "workspace.deleted": "Workspace deleted",
  "workspace.deletion_hold_set": "Deletion hold set",
  "workspace.deletion_hold_cleared": "Deletion hold cleared",
  "membership.added": "Member added",
  "membership.role_changed": "Role changed",
  "membership.removed": "Member removed",
  "membership.left": "Member left",
  "membership.ownership_recovered": "Ownership recovered",
  "membership.merged_duplicate": "Duplicate membership merged",
  "membership.claimed": "Migrated membership claimed at sign-in",
  "invitation.created": "Invitation sent",
  "invitation.accepted": "Invitation accepted",
  "invitation.revoked": "Invitation revoked",
  "credential.created": "Key created",
  "credential.revoked": "Key revoked",
  "license.written": "Licenses bought or changed",
  "license.ended": "Licenses ended",
  "seat.assigned": "License assigned",
  "seat.released": "License released",
};

/** A readable name for an audit action; an action this UI does not know shows as its raw name. */
export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Who did it, in words. */
export function actorLabel(actor: AuditEventView["actor"]): string {
  switch (actor.kind) {
    case "user":
      return actor.email ?? "A user";
    case "credential":
      return actor.credentialId ? `Key ${actor.credentialId}` : "A key";
    case "service": {
      const service = actor.service ? `${capitalize(actor.service)} service` : "A service";
      return actor.email ? `${service}, for ${actor.email}` : service;
    }
    case "system":
      return "System";
  }
}

/** The sentence as plain text, for labels and tests. */
export function plainText(text: AuditText): string {
  return text.map((run) => (typeof run === "string" ? run : run.strong)).join("");
}

const strong = (value: string) => ({ strong: value });
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const isRole = (value: unknown): value is WorkspaceRole =>
  typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
const role = (value: unknown): string | null => (isRole(value) ? ROLE_LABELS[value] : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sameAddress = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const inParens = (value: string | null) => (value ? ` (${value})` : "");

/** What an ended membership took with it: the keys it created and the invitations it sent. */
function endedNotes(after: Snapshot): string[] {
  const keys = count(after.revokedCredentialIds);
  const invitations = count(after.revokedInvitationIds);
  const parts = [
    keys ? plural(keys, "key", "keys") : null,
    invitations ? plural(invitations, "pending invitation", "pending invitations") : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? [`Their ${parts.join(" and ")} ${keys + invitations === 1 ? "was" : "were"} revoked with it.`] : [];
}

/** The event as a sentence about what happened, plus any further facts worth a line. */
export function describeAuditEvent(event: AuditEventView): AuditDescription {
  const target: Snapshot = event.target ?? {};
  const before: Snapshot = event.before ?? {};
  const after: Snapshot = event.after ?? {};
  // Invitation events name the invited address in `target`; `invitation.created` always had it in `after`.
  const email = text(target.email) ?? text(after.email);
  const done = (summary: AuditText, notes: string[] = []): AuditDescription => ({ summary, notes });

  switch (event.action) {
    case "workspace.created": {
      const name = text(after.name);
      return done(name ? ["Created the workspace ", strong(name)] : ["Created the workspace"]);
    }
    case "workspace.renamed": {
      const from = text(before.name);
      const to = text(after.name);
      if (from && to) return done(["Renamed the workspace from ", strong(from), " to ", strong(to)]);
      return done(to ? ["Renamed the workspace to ", strong(to)] : ["Renamed the workspace"]);
    }
    case "workspace.deleted": {
      const name = text(before.name);
      return done(name ? ["Deleted the workspace ", strong(name)] : ["Deleted the workspace"]);
    }
    case "workspace.deletion_hold_set": {
      // The panel names the service beside the sentence, so the sentence says only what holds the workspace.
      const reason = text(after.reason);
      const held = typeof after.count === "number" ? after.count : null;
      if (text(target.service) === "store" && reason === OWNS_MINIAPPS_HOLD_REASON) {
        // Events are append-only and an older one counted published miniapps only, so the sentence says
        // what the Store held the workspace for, and claims nothing about what it owned.
        const heldFor = held === null ? "its miniapps" : plural(held, "miniapp", "miniapps");
        return done([`Held the workspace from deletion for ${heldFor}`]);
      }
      const why = reason ? ` (${reason.replace(/_/g, " ")}${held === null ? "" : `: ${held}`})` : "";
      return done([`Held the workspace from deletion${why}`]);
    }
    case "workspace.deletion_hold_cleared":
      return done(["Stopped holding the workspace from deletion"]);
    case "membership.added": {
      const as = role(after.role);
      const asRole: AuditText = as ? [" as ", strong(as)] : [];
      // Joining by accepting an invitation is recorded with the new member as the actor.
      if (email && !sameAddress(email, text(event.actor.email))) return done(["Added ", strong(email), ...asRole]);
      return done(["Joined the workspace", ...asRole]);
    }
    case "membership.role_changed": {
      const from = role(before.role);
      const to = role(after.role);
      const who: AuditText = email ? [strong(email)] : ["a member"];
      if (from && to) return done(["Changed ", ...who, " from ", strong(from), " to ", strong(to)]);
      return done(["Changed the role of ", ...who]);
    }
    case "membership.removed": {
      const who: AuditText = email ? [strong(email)] : ["a member"];
      const reason = text(after.endedReason) === "account_deleted" ? " because their account was deleted" : "";
      return done(["Removed ", ...who, `${inParens(role(before.role))}${reason}`], endedNotes(after));
    }
    case "membership.left":
      return done([`Left the workspace${inParens(role(before.role))}`], endedNotes(after));
    case "membership.ownership_recovered": {
      const was = role(before.role);
      const suffix = was ? ` (was ${was})` : "";
      if (email) return done(["Made ", strong(email), " an ", strong("Owner"), suffix]);
      return done([was ? "Made a member an " : "Added a new ", strong("Owner"), suffix]);
    }
    case "invitation.created": {
      const as = role(after.role);
      return done(["Invited ", email ? strong(email) : "someone", ...(as ? [" as ", strong(as)] : [])]);
    }
    case "invitation.accepted":
      if (email && !sameAddress(email, text(event.actor.email))) return done(["Accepted the invitation for ", strong(email)]);
      return done([email ? "Accepted the invitation" : "Accepted an invitation"]);
    case "invitation.revoked": {
      const which: AuditText = email ? ["the invitation for ", strong(email)] : ["an invitation"];
      const as = inParens(role(before.role));
      switch (text(after.reason)) {
        case "superseded":
          return done(["Replaced ", ...which, `${as} with a new one`]);
        case "inviter_account_deleted":
          return done(["Revoked ", ...which, `${as} because the inviter's account was deleted`]);
        default:
          return done(["Revoked ", ...which, as]);
      }
    }
    case "credential.created": {
      const name = text(target.name);
      const packages = strings(after.packageNames);
      const expires = text(after.expiresAt);
      const scope = [packages.length ? packages.join(", ") : "all packages", expires ? `expires ${formatDate(expires)}` : null]
        .filter(Boolean)
        .join(", ");
      return done(name ? ["Created the key ", strong(name), ` (${scope})`] : [`Created a key (${scope})`]);
    }
    case "credential.revoked": {
      const name = text(target.name);
      return done(name ? ["Revoked the key ", strong(name)] : ["Revoked a key"]);
    }
    default:
      return done([actionLabel(event.action)], readableChanges(event));
  }
}

// --- Changes, for actions without a sentence of their own and for the details ------------------------

/** Field names that are internal identifiers: shown only in the raw details. */
const INTERNAL_FIELD = /(^id$|Ids?$)/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Fields whose name is not the word a person reads: a license is one person's right to a product, so `seatsUsed` counts licenses assigned. */
const FIELD_LABELS: Record<string, string> = {seatsUsed: "Licenses assigned"};

/** "expiresAt" as "Expires at", "packageNames" as "Package names". */
function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? capitalize(field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase());
}

/** A value in words: roles capitalised, dates formatted, lists as lists; null for nothing at all. */
function readable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value.map(readable).filter((item): item is string => item !== null);
    return items.length ? items.join(", ") : null;
  }
  if (typeof value === "string") {
    if (isRole(value)) return ROLE_LABELS[value];
    if (ISO_DATE_TIME.test(value)) return formatDateTime(value);
    return value.trim() ? value : null;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** What changed, readably: internal ids and unchanged fields left out, "X → Y", or just "Y" when it is new. */
export function readableChanges(event: Pick<AuditEventView, "before" | "after">): string[] {
  const before: Snapshot = event.before ?? {};
  const after: Snapshot = event.after ?? {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((field) => !INTERNAL_FIELD.test(field));
  const lines: string[] = [];
  for (const field of fields) {
    const from = readable(before[field]);
    const to = readable(after[field]);
    if (from === to) continue;
    const label = fieldLabel(field);
    if (from === null) lines.push(`${label}: ${to}`);
    else if (to === null) lines.push(`${label}: ${from} (removed)`);
    else lines.push(`${label}: ${from} → ${to}`);
  }
  return lines;
}

const raw = (value: unknown) => {
  if (value === null || value === undefined) return "none";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

/** The event as recorded: `field: value` for its target, `field: before → after` for each change. */
export function rawLines(event: Pick<AuditEventView, "target" | "before" | "after">): string[] {
  const target = Object.entries(event.target ?? {}).map(([field, value]) => `${field}: ${raw(value)}`);
  const before: Snapshot = event.before ?? {};
  const after: Snapshot = event.after ?? {};
  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => raw(before[field]) !== raw(after[field]))
    .map((field) => `${field}: ${raw(before[field])} → ${raw(after[field])}`);
  return [...target, ...changes];
}
