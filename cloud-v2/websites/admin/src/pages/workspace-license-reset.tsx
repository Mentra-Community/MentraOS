import {useMutation, useQuery} from "@tanstack/react-query";
import {Button, Dialog, Spinner} from "@mentra/workspace-ui";
import {api} from "../lib/api";

export interface ResetPreview {workspaceId: string; name: string; products: number; licenses: number; assignments: number}
export interface ResetResult {endedProducts: number; releasedAssignments: number; canceledSubscriptions: number; expiredCheckouts: number}

export function WorkspaceLicenseReset({workspaceId, onClose, onReset}: {workspaceId: string; onClose(): void; onReset(result: ResetResult): void}) {
  const path = `/api/admin/workspace-license-resets/${encodeURIComponent(workspaceId)}`;
  const preview = useQuery({queryKey: ["workspace-license-reset", workspaceId], queryFn: () => api<ResetPreview>(path), staleTime: 0});
  const reset = useMutation({
    mutationFn: () => api<ResetResult>(path, {method: "POST", body: {confirmWorkspaceId: workspaceId}, timeoutMs: 150000}),
    onSuccess: onReset,
  });
  return (
    <Dialog open onClose={onClose} locked={reset.isPending} title="Reset licenses & billing?" className="max-w-md">
      {preview.isPending ? <p role="status"><Spinner /> Checking workspace…</p> : preview.isError ? (
        <div role="alert" className="space-y-3 text-sm"><p>{preview.error.message}</p><Button variant="secondary" onClick={() => void preview.refetch()}>Retry</Button></div>
      ) : preview.data ? (
        <>
          <p className="text-sm">Cancel test subscriptions and remove all licenses for <strong>{preview.data.name}</strong>? The workspace and its members will stay.</p>
          {reset.isError ? <p role="alert" className="text-sm text-destructive">{reset.error.message} Some subscriptions may already be canceled. Retry to finish.</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={reset.isPending} onClick={onClose}>Cancel</Button>
            <Button variant="destructive" disabled={reset.isPending} onClick={() => reset.mutate()}>{reset.isPending ? "Resetting…" : "Reset"}</Button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
