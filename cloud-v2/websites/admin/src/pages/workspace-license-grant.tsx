import { useMutation } from "@tanstack/react-query";
import {
  checkLicenseGrantRequest,
  LICENSE_GRANT_IDEMPOTENCY_HEADER,
  LICENSE_GRANT_LIMITS,
  licenseGrantEndProblem,
  parseLicenseGrantEnd,
  type LicenseGrant,
} from "@mentra/workspace-contract";
import { Button, Dialog, Input, Label, NativeSelect, Textarea } from "@mentra/workspace-ui";
import { useId, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";

/**
 * The products a grant is offered for, by the key billing's catalog names each with. Billing decides what it
 * sells (`not_for_sale` otherwise), so a product missing here is granted by typing its key under "Other".
 */
export const GRANT_PRODUCTS: ReadonlyArray<{ key: string; name: string }> = [{ key: "mentra.call.unlimited", name: "Mentra Call Unlimited" }];

/** The select's value for a product key the admin types. */
const OTHER_PRODUCT = "other";

/** How long Core may take: it waits a minute for billing, which asks its payment processor several things. */
export const GRANT_TIMEOUT_MS = 90_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A product's name for the admin: the one this page knows it by, or its key. */
export function grantProductName(product: string): string {
  return GRANT_PRODUCTS.find(known => known.key === product)?.name ?? product;
}

/** The end date the form starts with: a year from `now`, as a date in UTC (`2027-11-26`). */
export function defaultGrantEnd(now: number): string {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

/** The latest end date the form offers: the last whole day inside a grant's longest term. */
export function latestGrantEnd(now: number): string {
  return new Date(now + LICENSE_GRANT_LIMITS.maxDays * DAY_MS).toISOString().slice(0, 10);
}

/** What the form holds: every field as the admin typed it. */
export interface GrantForm {
  product: string;
  seats: string;
  /** A date, `YYYY-MM-DD`: the licenses end at the start of that day in UTC. */
  endsOn: string;
  note: string;
}

/** A grant as Core's route takes it in its body. */
export interface GrantBody {
  product: string;
  seats: number;
  endsAt: string;
  note?: string;
}

export type GrantFormResult = { ok: true; body: GrantBody } | { ok: false; message: string };

/**
 * The grant the form asks for, or what is wrong with it in words. The shape is checked by the contract's own
 * check, so the form refuses what Core would; the end is checked against `now` here because a date that is
 * past, or more than two years out, is the mistake a person makes. `checkEnd: false` skips that one check, for
 * sending again a grant already asked for: Core answers a repeat of its key with the grant it made, however near
 * or past its end, and holds only a new grant to the rule.
 */
export function parseGrantForm(form: GrantForm, now: number, opts: { checkEnd?: boolean } = {}): GrantFormResult {
  const { minSeats, maxSeats, maxDays, maxNoteLength } = LICENSE_GRANT_LIMITS;
  const product = form.product.trim();
  if (!product) return { ok: false, message: "Choose a product." };
  const seats = /^\d+$/.test(form.seats.trim()) ? Number(form.seats.trim()) : Number.NaN;
  if (!Number.isSafeInteger(seats) || seats < minSeats || seats > maxSeats) {
    return { ok: false, message: `Enter how many licenses, from ${minSeats} to ${maxSeats}.` };
  }
  const endsAtMs = parseLicenseGrantEnd(form.endsOn.trim());
  if (endsAtMs === null) return { ok: false, message: "Enter the date the licenses end." };
  const problem = opts.checkEnd === false ? null : licenseGrantEndProblem(endsAtMs, now);
  if (problem?.kind === "too_soon") return { ok: false, message: "The end date must be in the future." };
  if (problem?.kind === "too_late") return { ok: false, message: `The end date can be at most ${maxDays} days from today.` };
  const note = form.note.trim();
  if (note.length > maxNoteLength) return { ok: false, message: `The note is at most ${maxNoteLength} characters.` };
  // The contract's check has the last word on the product's spelling; the key is the route's header, not the body's.
  const checked = checkLicenseGrantRequest({ product, seats, endsAt: form.endsOn.trim(), note, idempotencyKey: "form" });
  if (!checked.ok) return { ok: false, message: `That can't be granted: ${checked.description}.` };
  return { ok: true, body: { product: checked.request.product, seats, endsAt: form.endsOn.trim(), ...(note ? { note } : {}) } };
}

/**
 * Billing's and Core's refusals in the admin's words. A grant never changes a license the workspace holds, so
 * `already_licensed` says what to do instead; the rest say whether trying again helps.
 */
export function grantRefusalMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : "Request failed";
  switch (error.code) {
    case "already_licensed":
      return "This workspace already holds this product, and a grant can't change it. To add licenses or move its end, the existing one has to be ended first: open the workspace and use End grant on its Licenses tab, if it was granted.";
    case "not_for_sale":
      return "Billing doesn't sell this product per license, so it can't be granted.";
    case "checkout_in_progress":
      return "A purchase or another grant of this product is being set up in this workspace. Try again in a minute.";
    case "reset_in_progress":
      return "This workspace's licenses are being reset. Try again when that has finished.";
    case "idempotency_conflict":
      return "This grant was already asked for with other details. Close this and start again.";
    case "billing_unavailable":
      return "Billing didn't answer. Nothing was charged; granting again is safe and makes at most one grant.";
    case "workspace_not_found":
      return "This workspace no longer exists.";
    default:
      return error.message;
  }
}

/**
 * Gives the workspace licenses through Core's grant route. `idempotencyKey` is the caller's: a repeat with the
 * same key and the same grant answers the grant already made, so a request that timed out is sent again as is.
 */
export function grantLicenses(workspaceId: string, body: GrantBody, idempotencyKey: string): Promise<LicenseGrant> {
  return api<LicenseGrant>(`/api/admin/organization/workspaces/${encodeURIComponent(workspaceId)}/license-grants`, {
    method: "POST",
    body,
    headers: { [LICENSE_GRANT_IDEMPOTENCY_HEADER]: idempotencyKey },
    timeoutMs: GRANT_TIMEOUT_MS,
  });
}

/** What the page says once a grant is made. */
export function grantedMessage(workspaceName: string, grant: Pick<LicenseGrant, "product" | "seats" | "endsAt">): string {
  const ends = new Date(grant.endsAt).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
  const licenses = grant.seats === 1 ? "1 license" : `${grant.seats} licenses`;
  return `${workspaceName} now has ${licenses} of ${grantProductName(grant.product)} until ${ends}. Nothing was charged. Its admins assign them to people on the workspace's Licenses page.`;
}

/**
 * The key for a grant: the same one while the form asks for the same grant, so sending it again after a
 * timeout makes nothing new, and a new one once any field changes, so a corrected grant is not refused as a
 * conflict with the one before it.
 */
export function grantKeyFor(previous: { signature: string; key: string } | null, body: GrantBody, newKey: () => string): { signature: string; key: string } {
  const signature = grantSignature(body);
  return previous?.signature === signature ? previous : { signature, key: newKey() };
}

/** What makes two grants the same grant, for {@link grantKeyFor}. */
export function grantSignature(body: GrantBody): string {
  return JSON.stringify([body.product, body.seats, body.endsAt, body.note ?? ""]);
}

/**
 * The form's grant to send: a repeat of the grant `previous` already asked for is sent whatever its end, so a retry
 * after a timeout still reaches Core with its key; anything else is checked in full.
 */
export function grantToSend(form: GrantForm, now: number, previous: { signature: string } | null): GrantFormResult {
  const repeat = parseGrantForm(form, now, { checkEnd: false });
  if (repeat.ok && previous?.signature === grantSignature(repeat.body)) return repeat;
  return parseGrantForm(form, now);
}

/**
 * Gives a workspace licenses of a product until a date, for a sale made outside the workspace portal (through
 * a reseller, for a pilot, or prepaid by invoice). Nothing is charged, and the licenses are assigned to nobody:
 * the workspace's Admins and Owners assign them. Core records who granted it and the note.
 */
export function LicenseGrantDialog({
  workspace,
  now = Date.now(),
  onClose,
  onGranted,
}: {
  workspace: { workspaceId: string; name: string };
  now?: number;
  onClose(): void;
  onGranted(grant: LicenseGrant): void;
}) {
  const [choice, setChoice] = useState(GRANT_PRODUCTS[0]!.key);
  const [otherProduct, setOtherProduct] = useState("");
  const [seats, setSeats] = useState("1");
  const [endsOn, setEndsOn] = useState(() => defaultGrantEnd(now));
  const [note, setNote] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const key = useRef<{ signature: string; key: string } | null>(null);
  const productId = useId();
  const otherId = useId();
  const seatsId = useId();
  const endId = useId();
  const noteId = useId();
  const grant = useMutation({
    mutationFn: (request: { body: GrantBody; key: string }) => grantLicenses(workspace.workspaceId, request.body, request.key),
    gcTime: 0,
    onSuccess: onGranted,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = grantToSend({ product: choice === OTHER_PRODUCT ? otherProduct : choice, seats, endsOn, note }, Date.now(), key.current);
    if (!parsed.ok) {
      setInvalid(parsed.message);
      return;
    }
    setInvalid(null);
    key.current = grantKeyFor(key.current, parsed.body, () => crypto.randomUUID());
    grant.mutate({ body: parsed.body, key: key.current.key });
  }

  const shown = invalid ?? (grant.error ? grantRefusalMessage(grant.error) : null);
  return (
    <Dialog
      open
      onClose={onClose}
      locked={grant.isPending}
      title="Grant licenses"
      description={
        <>
          Gives <strong>{workspace.name}</strong> licenses for a sale made outside the portal. Nothing is charged, and they end on the date below.
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor={productId}>Product</Label>
          <NativeSelect id={productId} className="w-full" value={choice} onChange={event => setChoice(event.target.value)}>
            {GRANT_PRODUCTS.map(product => (
              <option key={product.key} value={product.key}>
                {product.name}
              </option>
            ))}
            <option value={OTHER_PRODUCT}>Other product key…</option>
          </NativeSelect>
        </div>
        {choice === OTHER_PRODUCT ? (
          <div className="grid gap-2">
            <Label htmlFor={otherId}>Product key</Label>
            <Input id={otherId} autoComplete="off" placeholder="mentra.call.unlimited" value={otherProduct} onChange={event => setOtherProduct(event.target.value)} />
          </div>
        ) : null}
        <div className="flex flex-wrap gap-4">
          <div className="grid gap-2">
            <Label htmlFor={seatsId}>Licenses</Label>
            <Input
              id={seatsId}
              type="number"
              inputMode="numeric"
              min={LICENSE_GRANT_LIMITS.minSeats}
              max={LICENSE_GRANT_LIMITS.maxSeats}
              className="w-28"
              value={seats}
              onChange={event => setSeats(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={endId}>End on</Label>
            <Input id={endId} type="date" max={latestGrantEnd(now)} className="w-44" value={endsOn} onChange={event => setEndsOn(event.target.value)} />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={noteId}>Note</Label>
          <Textarea
            id={noteId}
            rows={2}
            maxLength={LICENSE_GRANT_LIMITS.maxNoteLength}
            placeholder="Who sold it and the invoice number"
            value={note}
            onChange={event => setNote(event.target.value)}
          />
          <p className="text-muted-foreground text-xs">Kept with the grant and in the admin audit log, for whoever reads it later.</p>
        </div>
        {shown ? (
          <p role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-sm">
            {shown}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={grant.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={grant.isPending}>
            {grant.isPending ? "Granting…" : "Grant licenses"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
