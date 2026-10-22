/**
 * Workspace settings: the name and ID, then a danger zone to leave or delete.
 *
 * Rename needs `workspace.settings.manage`, delete needs `workspace.delete` and the workspace's name
 * typed back, and leaving is offered to anyone who is a member (an organization admin acting from
 * outside the workspace has nothing to leave). The only owner cannot leave, so for them Leave is
 * disabled and says why. A workspace a service holds (`deletionHolds`, such as the Store's while it
 * owns a miniapp) cannot be deleted by anyone, so for them Delete is disabled and says why.
 * A host adds what deleting means in its context with `deleteNotice`. Leaving and deleting each ask in
 * a dialog (`ConfirmDialog`), and a refused one says why there, with the dialog still open.
 */

import { useQuery } from "@tanstack/react-query";
import { describeDeletionHolds, type WorkspaceDeletionHold, type WorkspaceDetail } from "@mentra/workspace-contract";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { WorkspaceApi } from "../api";
import { membersQuery, settingsDetailQuery, useWorkspaceMutation } from "../queries";
import { can } from "../roles";
import { licenseStrings } from "../strings/licenses";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { CopyButton, ErrorNotice, Panel, QueryGate } from "./common";
import { ConfirmDialog, useAsking } from "./confirm-dialog";

const confirmStrings = licenseStrings.confirm;

interface SettingsPanelProps {
  api: WorkspaceApi;
  workspaceId: string;
  /** Called after the workspace was deleted. The panel's data is already gone: navigate away. */
  onDeleted?(): void;
  /** Called after the viewer left the workspace. Their access is already gone: navigate away. */
  onLeft?(): void;
  /** A warning shown above the delete confirmation, for consequences that depend on the host. */
  deleteNotice?: ReactNode;
}

export function WorkspaceSettingsPanel(props: SettingsPanelProps) {
  const { api, workspaceId } = props;
  const detailResult = useQuery(settingsDetailQuery(api, workspaceId));
  return (
    <QueryGate result={detailResult}>
      {/* Keyed by workspace so one workspace's half-typed name or delete confirmation never carries to another. */}
      {(detail) => (
        <SettingsForms
          key={workspaceId}
          {...props}
          detail={detail}
          checkingHolds={detailResult.isFetching}
          onCheckHolds={() => void detailResult.refetch()}
        />
      )}
    </QueryGate>
  );
}

function SettingsForms({
  api,
  workspaceId,
  onDeleted,
  onLeft,
  deleteNotice,
  detail,
  checkingHolds,
  onCheckHolds,
}: SettingsPanelProps & {
  detail: WorkspaceDetail;
  checkingHolds: boolean;
  onCheckHolds(): void;
}) {
  const [name, setName] = useState(detail.name);
  const nameId = useId();

  const rename = useWorkspaceMutation(api, workspaceId, (next: { name: string; expectedRevision: number }) =>
    api.renameWorkspace(workspaceId, next.name, next.expectedRevision),
  );
  const leave = useWorkspaceMutation(api, workspaceId, () => api.leaveWorkspace(workspaceId), {
    workspaceGone: true,
  });
  const remove = useWorkspaceMutation(api, workspaceId, (typed: string) => api.deleteWorkspace(workspaceId, typed), {
    workspaceGone: true,
  });

  const canRename = can(detail, "workspace.settings.manage");
  const canDelete = can(detail, "workspace.delete");
  const isMember = detail.membership !== null;
  // An owner may read the member list, so whether they are its only owner is known before they try.
  const isOwner = detail.membership?.role === "owner";
  const members = useQuery({ ...membersQuery(api, workspaceId), enabled: isOwner });
  const onlyOwner = isOwner && members.data !== undefined && members.data.filter((m) => m.role === "owner").length === 1;
  const busy = rename.isPending || leave.isPending || remove.isPending;
  const trimmed = name.trim();

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed || trimmed === detail.name) return;
    rename.mutate({ name: trimmed, expectedRevision: detail.authorizationRevision });
  }

  return (
    <div className="space-y-6">
      <Panel title="General" description="How this workspace is named and identified.">
        {canRename ? (
          <form onSubmit={submitRename} className="grid gap-2">
            <Label htmlFor={nameId}>Workspace name</Label>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                id={nameId}
                required
                maxLength={64}
                autoComplete="off"
                className="w-full max-w-sm"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" disabled={busy || trimmed === "" || trimmed === detail.name}>
                Save name
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-1">
            <span className="text-muted-foreground text-xs">Workspace name</span>
            <span className="text-[15px] font-semibold">{detail.name}</span>
            <span className="text-muted-foreground text-xs">Only workspace admins and owners can rename it.</span>
          </div>
        )}
        <ErrorNotice error={rename.error} />

        <div className="grid gap-2 border-t pt-5">
          <span className="text-sm font-semibold">Workspace ID</span>
          <div className="flex flex-wrap items-center gap-3">
            <code className="bg-surface flex h-9 items-center rounded-full border px-4 font-mono text-[13px] select-all">
              {workspaceId}
            </code>
            <CopyButton text={workspaceId} label="Copy" ariaLabel="Copy the workspace ID" />
          </div>
          <span className="text-muted-foreground text-sm">Tools and support may ask for it.</span>
        </div>
      </Panel>

      {isMember || canDelete ? (
        <Card role="region" aria-label="Danger zone" className="gap-0 py-0">
          <CardHeader className="border-b py-6">
            <CardTitle className="text-destructive text-lg">Danger zone</CardTitle>
            <CardDescription>These actions end access and cannot be undone here.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y px-0">
            {isMember ? (
              <LeaveSection
                workspaceName={detail.name}
                onlyOwner={onlyOwner}
                busy={busy}
                onLeave={async () => {
                  rename.reset();
                  await leave.mutateAsync(undefined);
                  onLeft?.();
                }}
              />
            ) : null}

            {canDelete ? (
              <DeleteSection
                workspaceName={detail.name}
                holds={detail.deletionHolds ?? []}
                checkingHolds={checkingHolds}
                onCheckHolds={onCheckHolds}
                deleteNotice={deleteNotice}
                busy={busy}
                onDelete={async (typed) => {
                  rename.reset();
                  await remove.mutateAsync(typed);
                  onDeleted?.();
                }}
              />
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Leaving: asked in a dialog, and disabled (saying why) for the workspace's only owner. `onLeave` rejects with the
 * refusal, which the dialog shows.
 */
export function LeaveSection({
  workspaceName,
  onlyOwner,
  busy,
  onLeave,
}: {
  workspaceName: string;
  onlyOwner: boolean;
  busy: boolean;
  onLeave(): Promise<void>;
}) {
  const noteId = useId();
  const ask = useAsking<string>((id) => id, busy);
  const t = confirmStrings.leave;
  return (
    <section aria-label="Leave workspace" className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
      <div className="max-w-xl space-y-1">
        <h3 className="text-[15px] font-semibold">Leave workspace</h3>
        <p id={noteId} className="text-muted-foreground text-sm">
          {onlyOwner
            ? "You're the only owner, so you can't leave. Make someone else an owner first."
            : "You lose access to this workspace. The last owner cannot leave: make someone else an owner first."}
        </p>
      </div>
      <Button
        ref={ask.trigger("leave")}
        type="button"
        variant="destructive-secondary"
        aria-label="Leave workspace"
        aria-describedby={onlyOwner ? noteId : undefined}
        disabled={busy || onlyOwner}
        onClick={() => ask.ask("leave")}
      >
        Leave workspace
      </Button>
      {ask.asking ? (
        <ConfirmDialog
          title={t.title(workspaceName)}
          description={t.body}
          cancelLabel={confirmStrings.cancel}
          confirmLabel={t.action}
          onConfirm={async () => {
            await onLeave();
            return null;
          }}
          onClose={ask.close}
        />
      ) : null}
    </section>
  );
}

/**
 * Deleting: a button that asks in a dialog, where the workspace's name is typed back before the button there works.
 * While a service holds the workspace (`holds`) the button is disabled and the section says why instead, with Check
 * again (`onCheckHolds`) for when the cause has been cleared elsewhere. `onDelete` rejects with the refusal, which
 * the dialog shows.
 */
export function DeleteSection({
  workspaceName,
  holds = [],
  checkingHolds = false,
  onCheckHolds,
  deleteNotice,
  busy,
  onDelete,
}: {
  workspaceName: string;
  /** What holds the workspace from deletion; deleting is offered only when there is nothing. */
  holds?: WorkspaceDeletionHold[];
  /** Whether the holds are being looked up again. */
  checkingHolds?: boolean;
  /** Look the holds up again. */
  onCheckHolds?(): void;
  deleteNotice?: ReactNode;
  busy: boolean;
  onDelete(typedName: string): Promise<void>;
}) {
  const heldId = useId();
  const held = holds.length > 0;
  const ask = useAsking<string>((id) => id, busy);
  const t = confirmStrings.delete;
  const typeName = t.typeName(workspaceName);

  return (
    <section aria-label="Delete workspace" className="flex flex-col gap-4 px-6 py-5">
      <div className="max-w-xl space-y-1">
        <h3 className="text-[15px] font-semibold">Delete workspace</h3>
        <p className="text-muted-foreground text-sm">{t.body}</p>
      </div>
      {held ? (
        <div className="flex max-w-xl flex-wrap items-start gap-3">
          <p id={heldId} role="note" className="rounded-notice bg-info text-info-foreground flex-1 px-4 py-3 text-sm">
            {describeDeletionHolds(holds)}
          </p>
          {onCheckHolds ? (
            <Button type="button" variant="secondary" size="sm" disabled={checkingHolds} onClick={onCheckHolds}>
              Check again
            </Button>
          ) : null}
        </div>
      ) : deleteNotice ? (
        <div role="note" className="rounded-notice bg-error text-error-foreground max-w-xl px-4 py-3 text-sm">
          {deleteNotice}
        </div>
      ) : null}
      <Button
        ref={ask.trigger("delete")}
        type="button"
        variant="destructive-secondary"
        className="self-start"
        aria-describedby={held ? heldId : undefined}
        disabled={held || busy}
        onClick={() => ask.ask("delete")}
      >
        Delete workspace
      </Button>
      {ask.asking ? (
        <ConfirmDialog
          title={t.title(workspaceName)}
          description={t.body}
          cancelLabel={confirmStrings.cancel}
          confirmLabel={t.action}
          typeToConfirm={{
            phrase: workspaceName,
            label: (
              <>
                {typeName.lead}
                <strong className="font-semibold">{typeName.name}</strong>
                {typeName.rest}
              </>
            ),
          }}
          onConfirm={async () => {
            // The button works only once the name is typed back, so the name typed is the workspace's.
            await onDelete(workspaceName);
            return null;
          }}
          onClose={ask.close}
        />
      ) : null}
    </section>
  );
}
