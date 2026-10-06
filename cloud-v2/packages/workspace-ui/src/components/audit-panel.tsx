/** The workspace's audit log, newest first, a page at a time. */

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AuditEventView } from "@mentra/workspace-contract";
import type { WorkspaceApi } from "../api";
import { formatDateTime } from "../lib/format";
import { auditQuery, workspaceDetailQuery } from "../queries";
import { can } from "../roles";
import { Button } from "../ui/button";
import { Loading, LoadError, Panel, Restricted } from "./common";

const TITLE = "Audit log";
const DESCRIPTION = "Who changed what in this workspace, newest first.";

const ACTION_LABELS: Record<string, string> = {
  "workspace.created": "Workspace created",
  "workspace.renamed": "Workspace renamed",
  "workspace.deleted": "Workspace deleted",
  "membership.added": "Member added",
  "membership.role_changed": "Role changed",
  "membership.removed": "Member removed",
  "membership.left": "Member left",
  "membership.ownership_recovered": "Ownership recovered",
  "membership.merged_duplicate": "Duplicate membership merged",
  "invitation.created": "Invitation created",
  "invitation.accepted": "Invitation accepted",
  "invitation.revoked": "Invitation revoked",
  "credential.created": "Credential created",
  "credential.revoked": "Credential revoked",
};

/** A readable name for an audit action; an action this UI does not know yet shows as its raw name. */
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
      return actor.credentialId ? `Credential ${actor.credentialId}` : "A credential";
    case "service":
      return actor.service ? `${capitalize(actor.service)} service` : "A service";
    case "system":
      return "System";
  }
}

const show = (value: unknown) => {
  if (value === null || value === undefined) return "none";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

/** What changed, as `field: before → after` lines for each field whose value differs. */
export function changeLines(event: Pick<AuditEventView, "before" | "after">): string[] {
  const before = event.before ?? {};
  const after = event.after ?? {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields
    .filter((field) => show(before[field]) !== show(after[field]))
    .map((field) => `${field}: ${show(before[field])} → ${show(after[field])}`);
}

export function WorkspaceAuditPanel({ api, workspaceId }: { api: WorkspaceApi; workspaceId: string }) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const canRead = can(detailResult.data, "workspace.audit.read");
  const auditResult = useInfiniteQuery({ ...auditQuery(api, workspaceId), enabled: canRead });

  if (detailResult.isPending) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <Loading />
      </Panel>
    );
  }
  if (detailResult.isError) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <LoadError error={detailResult.error} onRetry={() => void detailResult.refetch()} />
      </Panel>
    );
  }
  if (!canRead) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <Restricted>Only workspace admins can see the audit log.</Restricted>
      </Panel>
    );
  }
  if (auditResult.isPending) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <Loading />
      </Panel>
    );
  }
  if (auditResult.isError && !auditResult.data) {
    return (
      <Panel title={TITLE} description={DESCRIPTION}>
        <LoadError error={auditResult.error} onRetry={() => void auditResult.refetch()} />
      </Panel>
    );
  }

  const events = (auditResult.data?.pages ?? []).flatMap((page) => page.items);
  return (
    <Panel title={TITLE} description={DESCRIPTION}>
      {events.length === 0 ? (
        <Restricted>No audit events yet.</Restricted>
      ) : (
        <ol className="divide-y">
          {events.map((event) => {
            const changes = changeLines(event);
            return (
              <li key={event.eventId} className="space-y-0.5 py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{actionLabel(event.action)}</span>
                  <time dateTime={event.occurredAt} className="text-muted-foreground text-xs">
                    {formatDateTime(event.occurredAt)}
                  </time>
                </div>
                <div className="text-muted-foreground text-xs">by {actorLabel(event.actor)}</div>
                {changes.map((line) => (
                  <div key={line} className="font-mono text-xs">
                    {line}
                  </div>
                ))}
              </li>
            );
          })}
        </ol>
      )}
      {auditResult.isFetchNextPageError ? (
        <LoadError error={auditResult.error} onRetry={() => void auditResult.fetchNextPage()} />
      ) : null}
      {auditResult.hasNextPage && !auditResult.isFetchNextPageError ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={auditResult.isFetchingNextPage}
          onClick={() => void auditResult.fetchNextPage()}
        >
          Load more
        </Button>
      ) : null}
    </Panel>
  );
}
