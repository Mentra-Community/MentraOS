/**
 * Workspace settings: rename, leave, delete.
 *
 * Rename needs `workspace.settings.manage`, delete needs `workspace.delete` and the workspace's name
 * typed back, and leaving is offered to anyone who is a member (an organization admin acting from
 * outside the workspace has nothing to leave).
 */

import { useQuery } from "@tanstack/react-query";
import type { WorkspaceDetail } from "@mentra/workspace-contract";
import { useId, useState, type FormEvent } from "react";
import type { WorkspaceApi } from "../api";
import { useWorkspaceMutation, workspaceDetailQuery } from "../queries";
import { can } from "../roles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ConfirmButton, ErrorNotice, Panel, QueryGate } from "./common";

const TITLE = "Settings";
const DESCRIPTION = "Name, membership and deletion for this workspace.";

interface SettingsPanelProps {
  api: WorkspaceApi;
  workspaceId: string;
  /** Called after the workspace was deleted. The panel's data is already gone: navigate away. */
  onDeleted?(): void;
  /** Called after the viewer left the workspace. Their access is already gone: navigate away. */
  onLeft?(): void;
}

export function WorkspaceSettingsPanel(props: SettingsPanelProps) {
  const { api, workspaceId } = props;
  const detailResult = useQuery(workspaceDetailQuery(api, workspaceId));
  return (
    <Panel title={TITLE} description={DESCRIPTION}>
      <QueryGate result={detailResult}>
        {/* Keyed by workspace so one workspace's half-typed name or delete confirmation never carries to another. */}
        {(detail) => <SettingsForms key={workspaceId} {...props} detail={detail} />}
      </QueryGate>
    </Panel>
  );
}

function SettingsForms({ api, workspaceId, onDeleted, onLeft, detail }: SettingsPanelProps & { detail: WorkspaceDetail }) {
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
    <>
      {canRename ? (
        <form onSubmit={submitRename} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={nameId}>Workspace name</Label>
            <Input
              id={nameId}
              required
              maxLength={64}
              autoComplete="off"
              className="w-72"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy || trimmed === "" || trimmed === detail.name}>
            Save name
          </Button>
        </form>
      ) : (
        <div className="grid gap-1">
          <span className="text-muted-foreground text-xs">Workspace name</span>
          <span className="text-sm font-medium">{detail.name}</span>
        </div>
      )}

      {isMember ? (
        <section className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-semibold">Leave workspace</h3>
          <p className="text-muted-foreground text-sm">
            You lose access to this workspace. The last owner cannot leave: make someone else an owner first.
          </p>
          <ConfirmButton
            label="Leave workspace"
            ariaLabel="Leave workspace"
            prompt={`Leave ${detail.name}?`}
            confirmLabel="Confirm leave"
            disabled={busy}
            onConfirm={() => {
              rename.reset();
              remove.reset();
              leave.mutate(undefined, { onSuccess: () => onLeft?.() });
            }}
          />
        </section>
      ) : null}

      {canDelete ? (
        <section className="border-destructive/40 space-y-3 rounded-md border p-4">
          <h3 className="text-destructive text-sm font-semibold">Danger zone</h3>
          <p className="text-muted-foreground text-sm">
            Deleting a workspace ends every membership and invitation and revokes every credential. It cannot be undone,
            and it is refused while the workspace still owns published miniapps.
          </p>
          <form onSubmit={submitDelete} className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={confirmId}>
                Type <strong>{detail.name}</strong> to confirm
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

      <ErrorNotice error={rename.error ?? leave.error ?? remove.error} />
    </>
  );
}
