import { useMutation } from "@tanstack/react-query";
import type { OrganizationWorkspaceCreated } from "@mentra/workspace-contract";
import { Button, Dialog, Input, Label } from "@mentra/workspace-ui";
import { useId, useState, type FormEvent } from "react";
import { api } from "../lib/api";

/** The longest workspace name Core takes. */
export const WORKSPACE_NAME_MAX = 80;
/** The longest email address Core invites. */
export const EMAIL_MAX = 254;

export type NewWorkspaceInput = { ok: true; name: string; email: string } | { ok: false; message: string };

/**
 * What the form asks Core for: the workspace's name and the email of the person who will own it. Core checks
 * both again; this only catches what is plainly missing before a workspace is made that then has no invitation.
 */
export function parseNewWorkspace(name: string, email: string): NewWorkspaceInput {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  if (!trimmedName) return { ok: false, message: "Enter the workspace's name." };
  if (trimmedName.length > WORKSPACE_NAME_MAX) return { ok: false, message: `A workspace's name is at most ${WORKSPACE_NAME_MAX} characters.` };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) return { ok: false, message: "Enter the owner's email address." };
  // Checked here, as Core checks it, so a workspace is never made for an invitation Core would then refuse.
  if (trimmedEmail.length > EMAIL_MAX) return { ok: false, message: `An email address is at most ${EMAIL_MAX} characters.` };
  return { ok: true, name: trimmedName, email: trimmedEmail };
}

/** A workspace made here, and whether its Owner's invitation went out. */
export interface CreatedWorkspace {
  workspaceId: string;
  name: string;
  email: string;
  /** Null when the invitation was sent; otherwise why it was not, in Core's words. */
  invitationProblem: string | null;
}

/**
 * Makes a workspace with no members, then invites `email` as its Owner: two requests, because the person
 * usually has no Mentra account yet, and an invitation is how such a person joins. The workspace exists once
 * the first succeeds, so a failed invitation is reported with it, not thrown: sending the invitation again
 * from the workspace's Invitations tab finishes the job, and making the workspace again would leave two.
 */
export async function createWorkspaceForInvitedOwner(input: { name: string; email: string }): Promise<CreatedWorkspace> {
  const workspace = await api<OrganizationWorkspaceCreated>("/api/admin/organization/workspaces", { method: "POST", body: { name: input.name } });
  const created = { workspaceId: workspace.workspaceId, name: workspace.name, email: input.email };
  try {
    await api(`/api/admin/workspaces/${encodeURIComponent(workspace.workspaceId)}/invitations`, {
      method: "POST",
      body: { email: input.email, role: "owner" },
    });
    return { ...created, invitationProblem: null };
  } catch (error) {
    return { ...created, invitationProblem: error instanceof Error ? error.message : "Request failed" };
  }
}

/** What the page says once a workspace is made: that its Owner was invited, or what is left to do. */
export function createdWorkspaceMessage(created: CreatedWorkspace): string {
  return created.invitationProblem === null
    ? `${created.name} was created and ${created.email} was invited as its owner. The invitation expires in 14 days; until they accept, the workspace has no owner.`
    : `${created.name} was created, but the invitation to ${created.email} was not sent: ${created.invitationProblem} Open the workspace and invite its owner from Invitations.`;
}

/**
 * Asks for a new workspace's name and its Owner's email, makes the workspace and invites them. For a customer
 * set up by Mentra: the Owner need not have a Mentra account, and signs up from the invitation.
 */
export function CreateWorkspaceDialog({ onClose, onCreated }: { onClose(): void; onCreated(created: CreatedWorkspace): void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const nameId = useId();
  const emailId = useId();
  const create = useMutation({ mutationFn: createWorkspaceForInvitedOwner, gcTime: 0, onSuccess: onCreated });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseNewWorkspace(name, email);
    if (!parsed.ok) {
      setInvalid(parsed.message);
      return;
    }
    setInvalid(null);
    create.mutate({ name: parsed.name, email: parsed.email });
  }

  const shown = invalid ?? (create.error ? create.error.message : null);
  return (
    <Dialog
      open
      onClose={onClose}
      locked={create.isPending}
      title="New workspace"
      description="Makes a workspace and invites its owner by email. They don't need a Mentra account yet: they sign up from the invitation."
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor={nameId}>Workspace name</Label>
          <Input id={nameId} autoFocus autoComplete="off" maxLength={WORKSPACE_NAME_MAX} value={name} onChange={event => setName(event.target.value)} />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={emailId}>Owner's email</Label>
          <Input id={emailId} type="email" autoComplete="off" maxLength={EMAIL_MAX} value={email} onChange={event => setEmail(event.target.value)} />
        </div>
        {shown ? (
          <p role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-sm">
            {shown}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={create.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create and invite"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
