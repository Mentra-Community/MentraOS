/** Chooses among the caller's workspaces, and optionally creates a new one. */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import type { WorkspaceApi } from "../api";
import { workspaceKeys, workspaceListQuery } from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { NativeSelect } from "../ui/native-select";
import { ErrorNotice, QueryGate } from "./common";

export function WorkspacePicker({
  api,
  value,
  onChange,
  allowCreate = false,
}: {
  api: WorkspaceApi;
  value: string | null;
  onChange(workspaceId: string): void;
  /** Offer "New workspace". The server decides who may actually create one and says so when it refuses. */
  allowCreate?: boolean;
}) {
  const client = useQueryClient();
  const listResult = useQuery(workspaceListQuery(api));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const selectId = useId();
  const nameId = useId();

  const create = useMutation({
    mutationFn: (workspaceName: string) => api.createWorkspace(workspaceName),
    gcTime: 0,
    onSuccess: async (created) => {
      client.setQueryData(workspaceKeys.detail(api, created.workspaceId), created);
      await client.invalidateQueries({ queryKey: workspaceKeys.list(api) });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(trimmed, {
      onSuccess: (created) => {
        setCreating(false);
        setName("");
        onChange(created.workspaceId);
      },
    });
  }

  return (
    <div className="space-y-3">
      <QueryGate result={listResult} loadingLabel="Loading workspaces…">
        {(workspaces) => {
          const known = workspaces.some((workspace) => workspace.workspaceId === value);
          return (
            <div className="flex flex-wrap items-center gap-3">
              {workspaces.length > 0 ? (
                <div className="flex items-center gap-2">
                  <Label htmlFor={selectId}>Workspace</Label>
                  <NativeSelect
                    id={selectId}
                    aria-label="Workspace"
                    value={known ? (value ?? "") : ""}
                    onChange={(event) => {
                      if (event.target.value) onChange(event.target.value);
                    }}
                  >
                    {known ? null : (
                      <option value="" disabled>
                        Select a workspace
                      </option>
                    )}
                    {workspaces.map((workspace) => (
                      <option key={workspace.workspaceId} value={workspace.workspaceId}>
                        {workspace.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">You are not in any workspace yet.</p>
              )}
              {allowCreate && !creating ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
                  <PlusIcon /> New workspace
                </Button>
              ) : null}
            </div>
          );
        }}
      </QueryGate>

      {allowCreate && creating ? (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={nameId}>Workspace name</Label>
            <Input
              id={nameId}
              required
              autoFocus
              maxLength={64}
              autoComplete="off"
              className="w-64"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={create.isPending || name.trim() === ""}>
            Create workspace
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              create.reset();
              setCreating(false);
              setName("");
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      <ErrorNotice error={create.error} />
    </div>
  );
}
