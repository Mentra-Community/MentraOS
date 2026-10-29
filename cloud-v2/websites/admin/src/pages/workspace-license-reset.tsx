import {useMutation, useQuery} from "@tanstack/react-query";
import {Button, Dialog, Input, Label, Spinner} from "@mentra/workspace-ui";
import {useId, useState} from "react";
import {api} from "../lib/api";

export interface ResetPreview {workspaceId: string; name: string; products: number; licenses: number; assignments: number}
export interface ResetResult {endedProducts: number; releasedAssignments: number; canceledSubscriptions: number; expiredCheckouts: number}

export function canConfirmReset(workspaceId: string, confirmation: string, reason: string, acknowledged: boolean): boolean {
  return confirmation === workspaceId && reason.trim().length >= 5 && reason.length <= 500 && acknowledged;
}

/** Two deliberate steps in one dialog, with the exact target visible throughout. */
export function WorkspaceLicenseReset({workspaceId, onClose, onReset}: {workspaceId: string; onClose(): void; onReset(result: ResetResult): void}) {
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const id = useId();
  const path = `/api/admin/workspace-license-resets/${encodeURIComponent(workspaceId)}`;
  const preview = useQuery({queryKey: ["workspace-license-reset", workspaceId], queryFn: () => api<ResetPreview>(path), staleTime: 0});
  const reset = useMutation({
    mutationFn: () => api<ResetResult>(path, {method: "POST", body: {confirmWorkspaceId: confirmation, reason}, timeoutMs: 150000}),
    onSuccess: onReset,
  });
  return (
    <Dialog open onClose={onClose} locked={reset.isPending} title={confirming ? "Confirm staging reset" : "Reset staging licenses & billing?"} className="max-w-lg">
      <div className="space-y-2">
        <p className="font-semibold">{preview.data?.name ?? "Workspace"}</p>
        <code className="block break-all text-xs">{workspaceId}</code>
        <p className="text-sm font-semibold text-destructive">Staging only · This cannot be undone.</p>
      </div>
      {preview.isPending ? <p role="status"><Spinner /> Checking workspace…</p> : preview.isError ? (
        <div role="alert" className="space-y-3 text-sm"><p>{preview.error.message}</p><Button variant="secondary" onClick={() => void preview.refetch()}>Retry</Button></div>
      ) : preview.data ? (
        <>
          <div className="space-y-3 text-sm">
            <p>This workspace currently has {preview.data.licenses} license{preview.data.licenses === 1 ? "" : "s"} across {preview.data.products} product{preview.data.products === 1 ? "" : "s"} and {preview.data.assignments} assignment{preview.data.assignments === 1 ? "" : "s"}.</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Cancel all its test subscriptions immediately.</li>
              <li>Expire unfinished checkouts so they cannot be completed.</li>
              <li>End its licenses and remove everyone’s license access.</li>
            </ul>
            <p>Members, ownership, keys, and the workspace stay intact. Canceled billing history stays available. The workspace can buy licenses again.</p>
          </div>
          {!confirming ? (
            <div className="flex flex-wrap justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="destructive-secondary" onClick={() => setConfirming(true)}>Continue to confirmation</Button></div>
          ) : (
            <form className="space-y-4" onSubmit={event => {event.preventDefault(); if (!reset.isPending && canConfirmReset(workspaceId, confirmation, reason, acknowledged)) reset.mutate();}}>
              <div className="space-y-2"><Label htmlFor={`${id}-confirm`}>Type the workspace ID above to confirm</Label><Input id={`${id}-confirm`} autoComplete="off" value={confirmation} disabled={reset.isPending} onChange={event => setConfirmation(event.target.value)} /></div>
              <div className="space-y-2"><Label htmlFor={`${id}-reason`}>Reason for reset</Label><Input id={`${id}-reason`} value={reason} minLength={5} maxLength={500} disabled={reset.isPending} onChange={event => setReason(event.target.value)} placeholder="For example: restart subscription testing" /></div>
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={reset.isPending} onChange={event => setAcknowledged(event.target.checked)} className="mt-1" />I understand this immediately removes every member’s licensed access in this workspace.</label>
              {reset.isError ? <p role="alert" className="text-sm text-destructive">{reset.error.message} Some subscriptions may already have been canceled. Retry to finish the reset safely.</p> : null}
              <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="secondary" disabled={reset.isPending} onClick={() => setConfirming(false)}>Back</Button><Button type="submit" variant="destructive" disabled={reset.isPending || !canConfirmReset(workspaceId, confirmation, reason, acknowledged)}>{reset.isPending ? "Resetting…" : "Reset licenses & billing"}</Button></div>
            </form>
          )}
        </>
      ) : null}
    </Dialog>
  );
}
