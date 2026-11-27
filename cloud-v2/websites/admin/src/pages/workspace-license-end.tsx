import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LICENSE_GRANT_LIMITS, type AdminLicenseView, type LicenseGrantEnded } from "@mentra/workspace-contract";
import { Button, Dialog, Label, Textarea } from "@mentra/workspace-ui";
import { useId, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { LICENSES_QUERY_KEY, licenseState, WorkspaceLicenses } from "./licenses";
import { GRANT_TIMEOUT_MS, grantProductName } from "./workspace-license-grant";

/**
 * Whether End grant is offered on a license: one that is active at `now`. Core's list does not say whether a
 * license was granted or bought, so it is offered on every active one, and billing refuses a purchase
 * (`not_a_grant`): only a grant is ever ended from here.
 */
export function canEndGrant(license: Pick<AdminLicenseView, "endedAt" | "endedReason" | "validFrom" | "paidThrough">, now: number = Date.now()): boolean {
  return licenseState(license, now).kind === "active";
}

/**
 * Ends the workspace's grant of `product` now, through Core's route. `note` says why, for the admin audit log;
 * a blank one is not sent. Asking again after a failure is safe: a grant that had ended answers `grant_not_found`.
 */
export function endLicenseGrant(workspaceId: string, product: string, note: string): Promise<LicenseGrantEnded> {
  const why = note.trim();
  return api<LicenseGrantEnded>(
    `/api/admin/organization/workspaces/${encodeURIComponent(workspaceId)}/license-grants/${encodeURIComponent(product)}/end`,
    { method: "POST", ...(why ? { body: { note: why } } : {}), timeoutMs: GRANT_TIMEOUT_MS },
  );
}

/**
 * Billing's and Core's refusals in the admin's words. Only a grant is ended here: what the workspace bought, or
 * a grant it renewed and so pays for, is the workspace's to cancel.
 */
export function endGrantRefusalMessage(error: unknown, product: string): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : "Request failed";
  const name = grantProductName(product);
  switch (error.code) {
    case "not_a_grant":
      return `This workspace bought ${name}; it wasn't granted, so it can't be ended here. Its admins cancel it on the workspace's own Licenses page.`;
    case "grant_renewed":
      return `This workspace renewed this grant, so ${name} is now its own subscription and can't be ended here. Its admins cancel it on the workspace's own Licenses page.`;
    case "grant_not_found":
      return `This workspace has no grant of ${name} running. It may have ended already: refresh the list.`;
    case "billing_unavailable":
      return "Billing didn't answer, so the grant may or may not have ended. Check the list, and try again if it is still active.";
    case "checkout_in_progress":
      return "A purchase or a grant of this product is being set up in this workspace. Try again in a minute.";
    case "reset_in_progress":
      return "This workspace's licenses are being reset. Try again when that has finished.";
    case "workspace_not_found":
      return "This workspace no longer exists.";
    default:
      return error.message;
  }
}

/** What the page says once a grant has ended. */
export function grantEndedMessage(workspaceName: string, ended: Pick<LicenseGrantEnded, "product">): string {
  const name = grantProductName(ended.product);
  return `${workspaceName}'s grant of ${name} has ended. Its licenses are unassigned, and ${name} stops working for the people who had it within the hour. To give it back, grant it again.`;
}

/** Who loses the product when the grant ends, from how many of its licenses are assigned. */
export function endGrantConsequence(license: Pick<AdminLicenseView, "product" | "quantity" | "seatsUsed">): string {
  const name = grantProductName(license.product);
  if (license.seatsUsed === 0) {
    return license.quantity === 1
      ? `Its license isn't assigned to anyone, so nobody loses ${name}.`
      : `None of its ${license.quantity} licenses are assigned, so nobody loses ${name}.`;
  }
  const people = license.seatsUsed === 1 ? "The 1 person it is assigned to loses" : `The ${license.seatsUsed} people it is assigned to lose`;
  return `${people} ${name}: their licenses are unassigned at once, and it stops working for them within the hour.`;
}

/**
 * Asks before ending a workspace's grant of a product early. The grant's subscription is cancelled at once, so
 * its license ends now instead of on its date: everyone it is assigned to is unassigned, and loses the product
 * when their miniapp token is next issued (within the hour). Nothing is refunded, because a grant is never
 * charged. The note is optional and is kept in the admin audit log.
 */
export function EndGrantDialog({
  workspace,
  license,
  onClose,
  onEnded,
}: {
  workspace: { workspaceId: string; name: string };
  license: Pick<AdminLicenseView, "product" | "quantity" | "seatsUsed">;
  onClose(): void;
  onEnded(ended: LicenseGrantEnded): void;
}) {
  const [note, setNote] = useState("");
  const noteId = useId();
  const end = useMutation({
    mutationFn: (why: string) => endLicenseGrant(workspace.workspaceId, license.product, why),
    gcTime: 0,
    onSuccess: onEnded,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    end.mutate(note);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      locked={end.isPending}
      title="End this grant?"
      description={
        <>
          Ends <strong>{workspace.name}</strong>'s grant of <strong>{grantProductName(license.product)}</strong> now, before its date.
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm">{endGrantConsequence(license)}</p>
        <p className="text-muted-foreground text-sm">
          Nothing is refunded, because a grant is never charged. This can't be undone: to give the product back, grant it again. Only a grant ends here; a product the
          workspace bought stays as it is.
        </p>
        <div className="grid gap-2">
          <Label htmlFor={noteId}>Note (optional)</Label>
          <Textarea
            id={noteId}
            rows={2}
            maxLength={LICENSE_GRANT_LIMITS.maxNoteLength}
            placeholder="Why it is ending"
            value={note}
            onChange={event => setNote(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">Kept in the admin audit log, for whoever reads it later.</p>
        </div>
        {end.error ? (
          <p role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-sm">
            {endGrantRefusalMessage(end.error, license.product)}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={end.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={end.isPending}>
            {end.isPending ? "Ending…" : "End grant"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The open workspace's Licenses tab on the Workspaces page: what the workspace holds (`WorkspaceLicenses`), with
 * End grant on each active license for a caller who may grant (`canEndGrants`: they hold
 * `organization.licenses.grant`). Anyone else gets the list alone. Once a grant has ended, the page says so and
 * reads the list again. The organization-wide Licenses page offers none of this: it stays read-only.
 */
export function WorkspaceLicensesWithEnding({ workspace, canEndGrants }: { workspace: { workspaceId: string; name: string }; canEndGrants: boolean }) {
  const client = useQueryClient();
  const [ending, setEnding] = useState<AdminLicenseView | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const now = Date.now();
  return (
    <div className="space-y-4">
      {ending ? (
        <EndGrantDialog
          key={ending.licenseId}
          workspace={workspace}
          license={ending}
          onClose={() => setEnding(null)}
          onEnded={result => {
            setEnded(grantEndedMessage(workspace.name, result));
            setEnding(null);
            void client.invalidateQueries({ queryKey: LICENSES_QUERY_KEY });
          }}
        />
      ) : null}
      {ended ? (
        <p role="status" className="rounded-notice bg-info text-info-foreground px-4 py-3 text-sm">
          {ended}
        </p>
      ) : null}
      <WorkspaceLicenses
        workspaceId={workspace.workspaceId}
        rowAction={
          canEndGrants
            ? license =>
                canEndGrant(license, now) ? (
                  <Button
                    variant="destructive-secondary"
                    size="sm"
                    aria-label={`End the grant of ${grantProductName(license.product)}`}
                    onClick={() => {
                      setEnded(null);
                      setEnding(license);
                    }}
                  >
                    End grant
                  </Button>
                ) : null
            : undefined
        }
      />
    </div>
  );
}
