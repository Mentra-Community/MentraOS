/**
 * Workspace settings: the name and ID, then a danger zone to leave or delete.
 *
 * Rename needs `workspace.settings.manage`, delete needs `workspace.delete` and the workspace's name
 * typed back, and leaving is offered to anyone who is a member (an organization admin acting from
 * outside the workspace has nothing to leave). A host adds what deleting means in its context with
 * `deleteNotice`.
 */

import { useQuery } from "@tanstack/react-query";
import type { WorkspaceDetail } from "@mentra/workspace-contract";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { WorkspaceApi } from "../api";
import { useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { can } from "../roles";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ConfirmButton, CopyButton, ErrorNotice, Panel, QueryGate } from "./common";

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
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  return (
    <QueryGate result={detailResult}>
      {/* Keyed by workspace so one workspace's half-typed name or delete confirmation never carries to another. */}
      {(detail) => <SettingsForms key={workspaceId} {...props} detail={detail} />}
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
}: SettingsPanelProps & { detail: WorkspaceDetail }) {
  const [name, setName] = useState(detail.name);
  const [confirmName, setConfirmName] = useState("");
  const nameId = useId();
  const confirmId = useId();

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
  const busy = rename.isPending || leave.isPending || remove.isPending;
  const trimmed = name.trim();

  function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed || trimmed === detail.name) return;
    leave.reset();
    remove.reset();
    rename.mutate({ name: trimmed, expectedRevision: detail.authorizationRevision });
  }

  function submitDelete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmName !== detail.name) return;
    rename.reset();
    leave.reset();
    remove.mutate(confirmName, { onSuccess: () => onDeleted?.() });
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
              <section className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
                <div className="max-w-xl space-y-1">
                  <h3 className="text-[15px] font-semibold">Leave workspace</h3>
                  <p className="text-muted-foreground text-sm">
                    You lose access to this workspace. The last owner cannot leave: make someone else an owner first.
                  </p>
                </div>
                <ConfirmButton
                  label="Leave workspace"
                  ariaLabel="Leave workspace"
                  prompt={`Leave ${detail.name}?`}
                  confirmLabel="Confirm leave"
                  disabled={busy}
                  outline
                  onConfirm={() => {
                    rename.reset();
                    remove.reset();
                    leave.mutate(undefined, { onSuccess: () => onLeft?.() });
                  }}
                />
              </section>
            ) : null}

            {canDelete ? (
              <section className="space-y-4 px-6 py-5">
                <div className="max-w-xl space-y-1">
                  <h3 className="text-[15px] font-semibold">Delete workspace</h3>
                  <p className="text-muted-foreground text-sm">
                    Deleting a workspace ends every membership and invitation and revokes every credential. It cannot
                    be undone.
                  </p>
                </div>
                {deleteNotice ? (
                  <div
                    role="note"
                    className="rounded-notice bg-error text-error-foreground max-w-xl px-4 py-3 text-sm"
                  >
                    {deleteNotice}
                  </div>
                ) : null}
                <form onSubmit={submitDelete} className="flex flex-wrap items-end gap-3">
                  <div className="grid gap-2">
                    <Label htmlFor={confirmId}>
                      <span className="font-normal">
                        Type <strong className="font-semibold">{detail.name}</strong> to confirm
                      </span>
                    </Label>
                    <Input
                      id={confirmId}
                      autoComplete="off"
                      className="w-72"
                      value={confirmName}
                      onChange={(event) => setConfirmName(event.target.value)}
                    />
                  </div>
                  <Button type="submit" variant="destructive" disabled={busy || confirmName !== detail.name}>
                    Delete workspace
                  </Button>
                </form>
              </section>
            ) : null}
            {leave.error || remove.error ? (
              <div className="px-6 py-4">
                <ErrorNotice error={leave.error ?? remove.error} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
