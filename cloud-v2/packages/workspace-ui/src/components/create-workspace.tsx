/**
 * Creating a workspace: the mutation, a name-only form and a dialog around it.
 *
 * The server decides who may create a workspace (and says why when it refuses), so these only collect a
 * name. The creator becomes the new workspace's owner; its detail goes straight into the cache, so the
 * host can open it without waiting for another round trip.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceDetail } from "@mentra/workspace-contract";
import { useId, useState, type FormEvent } from "react";
import type { WorkspaceApi } from "../api";
import { cn } from "../lib/utils";
import { workspaceKeys } from "../queries";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ErrorNotice } from "./common";

/** The longest workspace name Core accepts. */
const NAME_MAX_LENGTH = 64;

/** Creates a workspace, seeds its detail and refreshes the caller's workspace list. */
export function useCreateWorkspace(api: WorkspaceApi) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createWorkspace(name),
    gcTime: 0,
    onSuccess: async (created) => {
      client.setQueryData(workspaceKeys.detail(api, created.workspaceId), created);
      await client.invalidateQueries({ queryKey: workspaceKeys.list(api) });
    },
  });
}

/** A workspace name and Create. `onCreated` runs once the new workspace is in the list. */
export function CreateWorkspaceForm({
  api,
  onCreated,
  onCancel,
  wide = false,
}: {
  api: WorkspaceApi;
  onCreated(workspace: WorkspaceDetail): void;
  /** Offer Cancel next to Create (in a dialog). */
  onCancel?(): void;
  /** One full-width Create button under the field, for a page that is only this form. */
  wide?: boolean;
}) {
  const create = useCreateWorkspace(api);
  const [name, setName] = useState("");
  const nameId = useId();
  const trimmed = name.trim();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trimmed) return;
    create.mutate(trimmed, { onSuccess: (created) => onCreated(created) });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor={nameId}>Workspace name</Label>
        <Input
          id={nameId}
          required
          autoFocus
          maxLength={NAME_MAX_LENGTH}
          autoComplete="off"
          placeholder="Acme Field Team"
          className={cn(wide && "h-12")}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <ErrorNotice error={create.error} />
      <div className={cn("flex justify-end gap-2.5 pt-2", wide && "block pt-0")}>
        {onCancel ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="submit"
          size={wide ? "lg" : "default"}
          className={cn(wide && "w-full")}
          disabled={create.isPending || trimmed === ""}
        >
          {create.isPending ? "Creating…" : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}
