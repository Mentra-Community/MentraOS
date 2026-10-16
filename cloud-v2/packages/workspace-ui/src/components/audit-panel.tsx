/** The workspace's audit log, newest first, a page at a time. */

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AuditEventView } from "@mentra/workspace-contract";
import type { WorkspaceApi } from "../api";
import { actorLabel, describeAuditEvent, rawLines, type AuditText } from "../lib/audit";
import { formatDateTime } from "../lib/format";
import { auditQuery, workspaceDetailQuery } from "../queries";
import { can } from "../roles";
import { Button } from "../ui/button";
import { LoadError, Panel, QueryGate, Restricted } from "./common";

const TITLE = "Audit log";
const DESCRIPTION = "Who changed what in this workspace, newest first.";

export function WorkspaceAuditPanel({ api, workspaceId }: { api: WorkspaceApi; workspaceId: string }) {
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  const auditResult = useInfiniteQuery({
    ...auditQuery(api, workspaceId),
    enabled: can(detailResult.data, "workspace.audit.read"),
  });

  return (
    <Panel title={TITLE} description={DESCRIPTION}>
      <QueryGate result={detailResult}>
        {(detail) =>
          !can(detail, "workspace.audit.read") ? (
            <Restricted>Only workspace admins can see the audit log.</Restricted>
          ) : (
            <QueryGate result={auditResult}>
              {(data) => {
                const events = data.pages.flatMap((page) => page.items);
                return (
                  <>
                    {events.length === 0 ? (
                      <Restricted>No audit events yet.</Restricted>
                    ) : (
                      <ol className="divide-y">
                        {events.map((event) => (
                          <AuditEntry key={event.eventId} event={event} />
                        ))}
                      </ol>
                    )}
                    {auditResult.isFetchNextPageError ? (
                      <LoadError error={auditResult.error} onRetry={() => void auditResult.fetchNextPage()} />
                    ) : null}
                    {auditResult.hasNextPage && !auditResult.isFetchNextPageError ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={auditResult.isFetchingNextPage}
                        onClick={() => void auditResult.fetchNextPage()}
                      >
                        Load more
                      </Button>
                    ) : null}
                  </>
                );
              }}
            </QueryGate>
          )
        }
      </QueryGate>
    </Panel>
  );
}

function AuditSentence({ text }: { text: AuditText }) {
  return (
    <>
      {text.map((run, index) =>
        typeof run === "string" ? (
          run
        ) : (
          <strong key={index} className="font-semibold">
            {run.strong}
          </strong>
        ),
      )}
    </>
  );
}

function AuditEntry({ event }: { event: AuditEventView }) {
  const { summary, notes } = describeAuditEvent(event);
  const details = rawLines(event);
  return (
    <li className="flex gap-3 py-3.5 text-sm first:pt-0 last:pb-0">
      <span aria-hidden="true" className="bg-brand mt-[7px] size-2 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <span className="min-w-0 text-[15px] [overflow-wrap:anywhere]">
            <AuditSentence text={summary} />
          </span>
          <time dateTime={event.occurredAt} className="text-muted-foreground text-xs whitespace-nowrap">
            {formatDateTime(event.occurredAt)}
          </time>
        </div>
        <div className="text-muted-foreground text-xs [overflow-wrap:anywhere]">by {actorLabel(event.actor)}</div>
        {notes.map((note) => (
          <p key={note} className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {note}
          </p>
        ))}
        {details.length > 0 ? (
          <details className="group pt-0.5">
            <summary className="text-muted-foreground hover:text-foreground w-fit cursor-pointer list-none text-xs font-semibold select-none [&::-webkit-details-marker]:hidden">
              <span className="group-open:hidden">Show details</span>
              <span className="hidden group-open:inline">Hide details</span>
            </summary>
            <div className="flex flex-wrap gap-1.5 pt-1.5">
              {details.map((line) => (
                <code key={line} className="bg-surface rounded-[8px] px-2 py-1 font-mono text-xs break-all">
                  {line}
                </code>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </li>
  );
}
