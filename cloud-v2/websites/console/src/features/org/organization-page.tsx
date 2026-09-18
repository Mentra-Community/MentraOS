import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { CheckCircle2, Mail, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { PackageName } from "@/components/package-name";
import { Badge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { displayNameForUser } from "@/features/session/session.api";
import { sessionQuery } from "@/features/session/session.queries";
import { isValidPackagePrefix, normalizePackagePrefix, suggestedOrgDefaults } from "./org-helpers";
import {
  getDeveloperOrg,
  getOrgAccess,
  inviteOrgMember,
  removeOrgMember,
  revokeOrgInvitation,
  saveDeveloperOrg,
  updateOrgMemberRole,
  type DeveloperOrg,
  type OrgInvitation,
  type OrgMember,
  type OrgRole,
} from "./org.api";

export function OrganizationPage() {
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery());
  const canLoadOrg = session.isSuccess;
  const orgQuery = useQuery({
    queryKey: ["developer-org"],
    queryFn: getDeveloperOrg,
    enabled: canLoadOrg,
  });
  const user = session.data?.user;
  const org = orgQuery.data?.org ?? session.data?.organizations?.[0] ?? null;
  const onboardingRequired = session.isSuccess ? (session.data.onboardingRequired ?? org === null) : false;
  const suggested = useMemo(() => suggestedOrgDefaults(user), [user]);
  const [displayName, setDisplayName] = useState(suggested.displayName);
  const [packagePrefix, setPackagePrefix] = useState(suggested.packagePrefix);
  const [inviteEmail, setInviteEmail] = useState("");
  const [creatingNewOrg, setCreatingNewOrg] = useState(false);
  const accessQuery = useQuery({
    queryKey: ["developer-org-access"],
    queryFn: getOrgAccess,
    enabled: canLoadOrg && Boolean(org),
  });

  useEffect(() => {
    if (!org || creatingNewOrg) return;
    setDisplayName(org.name);
    setPackagePrefix(org.packagePrefix);
  }, [creatingNewOrg, org]);

  useEffect(() => {
    if (org && !creatingNewOrg) return;
    setDisplayName(suggested.displayName);
    setPackagePrefix(suggested.packagePrefix);
  }, [creatingNewOrg, org, suggested.displayName, suggested.packagePrefix]);

  const normalizedPrefix = normalizePackagePrefix(packagePrefix);
  const previewPackageName = normalizedPrefix ? `${normalizedPrefix}.weather` : "io.acme.weather";
  const canEditPrefix = creatingNewOrg || !org || org.packagePrefixStatus === "rejected";
  const orgSave = useMutation({
    mutationFn: saveDeveloperOrg,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["console-session"] }),
        queryClient.invalidateQueries({ queryKey: ["developer-org"] }),
        queryClient.invalidateQueries({ queryKey: ["developer-org-access"] }),
        queryClient.invalidateQueries({ queryKey: ["developer-apps"] }),
      ]);
      // Keep the creation form (and not the old org's team controls) visible
      // until every cookie-selected org query has completed its refetch.
      setCreatingNewOrg(false);
    },
  });
  const inviteMember = useMutation({
    mutationFn: inviteOrgMember,
    onSuccess: async () => {
      setInviteEmail("");
      await queryClient.invalidateQueries({ queryKey: ["developer-org-access"] });
    },
  });
  const revokeInvite = useMutation({
    mutationFn: revokeOrgInvitation,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["developer-org-access"] });
    },
  });
  const removeMember = useMutation({
    mutationFn: removeOrgMember,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["developer-org-access"] });
    },
  });
  const updateMemberRole = useMutation({
    mutationFn: updateOrgMemberRole,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["developer-org-access"] });
    },
  });
  const viewerRole: OrgRole = accessQuery.data?.viewerRole ?? session.data?.viewerRole ?? "member";
  // Editing an existing org is owner-only (server-enforced); onboarding (no org
  // yet) is always allowed since the creator becomes the owner.
  const canEditOrg = creatingNewOrg || !org || viewerRole === "owner";
  const canSave =
    canEditOrg &&
    displayName.trim().length >= 2 &&
    isValidPackagePrefix(normalizedPrefix) &&
    !orgSave.isPending &&
    (creatingNewOrg || displayName.trim() !== org?.name || normalizedPrefix !== org?.packagePrefix);

  const isCreating = onboardingRequired || creatingNewOrg;

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-[1040px] px-4 py-4 sm:px-5 sm:py-6 md:px-8 md:py-8">
        <section>
          <Card className="rounded-[16px] border-[#e0e4de] bg-white py-0 shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
            <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="font-display text-[20px]">
                    {isCreating ? "Create your developer org" : "Developer org"}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {org && !creatingNewOrg ? <PrefixStatus status={org.packagePrefixStatus} /> : null}
                    {org ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 rounded-full px-3"
                        onClick={() => setCreatingNewOrg(value => !value)}
                      >
                        {creatingNewOrg ? null : <Plus className="size-4" />}
                        {creatingNewOrg ? "Cancel" : "New organization"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <CardDescription className="max-w-2xl text-[13px] leading-5 sm:text-[14px]">
                  Your org owns a unique package prefix. Every miniapp you create must live under it.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-5 p-4 sm:p-6">
              {isCreating ? (
                <div className="rounded-[14px] border border-[#ccefe2] bg-[#f1fbf6] p-4 text-sm leading-6 text-[#256953]">
                  Pick a namespace now so package names cannot drift into `com.google.*` or another org's space. Public
                  store review can verify domain or brand ownership later.
                </div>
              ) : null}

              <form
                className="space-y-5"
                onSubmit={event => {
                  event.preventDefault();
                  if (!canSave) return;
                  orgSave.mutate({
                    displayName: displayName.trim(),
                    packagePrefix: normalizedPrefix,
                    createNew: creatingNewOrg,
                  });
                }}
              >
                <div className="grid gap-4 md:grid-cols-2 md:items-start">
                  <Field label="Organization name" htmlFor="orgName">
                    <Input
                      id="orgName"
                      className="h-11 rounded-[12px] border-[#dfe3dc] bg-white px-3 shadow-none focus-visible:ring-[#9dddc7]/35 sm:px-4"
                      placeholder="Acme Labs"
                      value={displayName}
                      onChange={event => setDisplayName(event.target.value)}
                    />
                  </Field>

                  <Field label="Package prefix" htmlFor="packagePrefix">
                    <Input
                      id="packagePrefix"
                      className="h-11 rounded-[12px] border-[#dfe3dc] bg-white px-3 font-mono shadow-none focus-visible:ring-[#9dddc7]/35 sm:px-4"
                      placeholder="io.acme"
                      value={packagePrefix}
                      onChange={event => setPackagePrefix(event.target.value.toLowerCase().replace(/\s+/g, ""))}
                      disabled={!canEditPrefix}
                    />
                    {canEditPrefix ? (
                      <p className="mt-2 text-xs leading-5 text-[#8a8d95]">
                        Use lowercase reverse-DNS text. Reserved prefixes like `com.mentra` cannot be claimed unless the
                        account is allowed to own them.
                      </p>
                    ) : null}
                  </Field>
                </div>

                <div className="rounded-[14px] bg-[#f6f7f5] p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[#8a8d95]">
                    Miniapp package preview
                  </div>
                  <div className="mt-2 truncate text-[15px]">
                    <PackageName
                      packageName={previewPackageName}
                      packagePrefix={normalizedPrefix}
                      className="text-[15px]"
                    />
                  </div>
                  <div className="mt-2 text-sm leading-6 text-[#747780]">
                    Developers only choose the suffix, like `weather`; the org prefix is added and enforced
                    automatically.
                  </div>
                </div>

                {orgSave.isError ? (
                  <div className="rounded-[12px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
                    {orgSave.error instanceof Error ? orgSave.error.message : "Could not save organization."}
                  </div>
                ) : null}
                {orgSave.isSuccess ? (
                  <div className="rounded-[12px] bg-[#edf8f2] px-4 py-3 text-sm text-[#087d50]">
                    Organization saved.
                  </div>
                ) : null}

                <Button
                  className="h-10 w-full rounded-full bg-[#111217] px-5 text-white hover:bg-[#25262c] sm:w-auto"
                  disabled={!canSave}
                >
                  {orgSave.isPending ? "Saving..." : isCreating ? "Create organization" : "Save changes"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </section>

        {org && !creatingNewOrg ? (
          <TeamAccessSection
            access={accessQuery.data}
            error={accessQuery.error}
            isLoading={accessQuery.isLoading}
            currentOrg={org}
            viewerRole={viewerRole}
            inviteEmail={inviteEmail}
            setInviteEmail={setInviteEmail}
            inviteMember={inviteMember}
            revokeInvite={revokeInvite}
            removeMember={removeMember}
            updateMemberRole={updateMemberRole}
          />
        ) : null}
      </main>
    </AppShell>
  );
}

function PrefixStatus({ status }: { status: "unverified" | "verified" | "rejected" }) {
  if (status === "verified") {
    return <Badge tone="success" icon={CheckCircle2}>Verified</Badge>;
  }
  if (status === "rejected") {
    return <Badge tone="warn">Needs review</Badge>;
  }
  return <Badge tone="neutral">Unverified</Badge>;
}

type TeamAccessSectionProps = {
  access:
    | {
        org: DeveloperOrg;
        members: OrgMember[];
        invitations: OrgInvitation[];
      }
    | undefined;
  error: unknown;
  isLoading: boolean;
  currentOrg: DeveloperOrg;
  viewerRole: OrgRole;
  inviteEmail: string;
  setInviteEmail: (value: string) => void;
  inviteMember: UseMutationResult<
    { invitation: OrgInvitation; inviteUrl: string },
    Error,
    { email: string },
    unknown
  >;
  revokeInvite: UseMutationResult<{ ok: boolean }, Error, string, unknown>;
  removeMember: UseMutationResult<{ ok: boolean }, Error, string, unknown>;
  updateMemberRole: UseMutationResult<
    { ok: boolean; role: string },
    Error,
    { membershipId: string; role: "owner" | "admin" | "member" },
    unknown
  >;
};

function TeamAccessSection({
  access,
  error,
  isLoading,
  currentOrg,
  viewerRole,
  inviteEmail,
  setInviteEmail,
  inviteMember,
  revokeInvite,
  removeMember,
  updateMemberRole,
}: TeamAccessSectionProps) {
  const org = access?.org ?? currentOrg;
  const members = access?.members ?? [];
  const invitations = (access?.invitations ?? []).filter(invitation =>
    !["accepted", "revoked"].includes(invitation.state.toLowerCase()),
  );
  const accessRows: AccessRow[] = [
    ...invitations.map(invitation => ({ kind: "invitation" as const, invitation })),
    ...members.map(member => ({ kind: "member" as const, member })),
  ];
  const canManage = viewerRole === "owner" || viewerRole === "admin";
  const canInvite = canManage && inviteEmail.trim().includes("@") && !inviteMember.isPending;

  return (
    <section className="mt-5">
      <Card className="rounded-[16px] border-[#e0e4de] bg-white py-0 shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
        <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
          <CardTitle className="font-display text-[20px]">Team access</CardTitle>
          <CardDescription className="mt-1 max-w-2xl text-[13px] leading-5 sm:text-[14px]">
            Members share this org's package namespace and can work on its miniapps.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5 p-4 sm:p-6">
          {error ? (
            <div className="rounded-[12px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
              {error instanceof Error ? error.message : "Could not load team access."}
            </div>
          ) : null}

          <form
            className="grid gap-3 rounded-[14px] bg-[#f6f7f5] p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:p-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!canInvite) return;
              inviteMember.mutate({ email: inviteEmail.trim().toLowerCase() });
            }}
          >
            <div>
              <Label htmlFor="inviteEmail" className="mb-2 text-sm font-semibold text-[#1c1d22]">
                Invite by email
              </Label>
              <Input
                id="inviteEmail"
                type="email"
                className="h-11 rounded-[12px] border-[#dfe3dc] bg-white px-3 shadow-none focus-visible:ring-[#9dddc7]/35 sm:px-4"
                placeholder="teammate@example.com"
                value={inviteEmail}
                onChange={event => setInviteEmail(event.target.value)}
                disabled={!canManage}
              />
              {!canManage ? (
                <p className="mt-2 text-xs leading-5 text-[#8a8d95]">Only owners and admins can invite or remove members.</p>
              ) : null}
            </div>
            <Button
              className="h-11 rounded-full bg-[#111217] px-5 text-white hover:bg-[#25262c] sm:self-end"
              disabled={!canInvite}
            >
              <UserPlus className="size-4" />
              {inviteMember.isPending ? "Inviting..." : "Invite"}
            </Button>
          </form>

          {inviteMember.isError ? (
            <div className="rounded-[12px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
              {inviteMember.error.message || "Could not send invitation."}
            </div>
          ) : null}
          {inviteMember.isSuccess ? (
            <div className="rounded-[12px] bg-[#edf8f2] px-4 py-3 text-sm text-[#087d50]">
              <div>Invitation sent by email.</div>
              {inviteMember.data?.inviteUrl ? (
                <div className="mt-1 break-all text-xs text-[#256953]">
                  Or share this link: {inviteMember.data.inviteUrl}
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-display text-[17px] font-semibold text-[#14151b]">Members</h3>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[#8a8d95]">
                <span>{isLoading ? "Loading" : `${accessRows.length} total`}</span>
                {invitations.length ? <span className="text-[#087d50]">{invitations.length} pending</span> : null}
              </div>
            </div>
            <div className="overflow-hidden rounded-[14px] border border-[#eceeeb]">
              {accessRows.length ? (
                accessRows.map(row => (
                  <AccessRow
                    key={row.kind === "invitation" ? `invite:${row.invitation.id}` : `member:${row.member.id}`}
                    row={row}
                    canManage={canManage}
                    viewerRole={viewerRole}
                    removeMember={removeMember}
                    revokeInvite={revokeInvite}
                    updateMemberRole={updateMemberRole}
                  />
                ))
              ) : (
                <EmptyTeamState icon={Users} title={isLoading ? "Loading members..." : "No members yet"} />
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

type AccessRow =
  | { kind: "invitation"; invitation: OrgInvitation }
  | { kind: "member"; member: OrgMember };

function AccessRow({
  row,
  canManage,
  viewerRole,
  removeMember,
  revokeInvite,
  updateMemberRole,
}: {
  row: AccessRow;
  canManage: boolean;
  viewerRole: OrgRole;
  removeMember: UseMutationResult<{ ok: boolean }, Error, string, unknown>;
  revokeInvite: UseMutationResult<{ ok: boolean }, Error, string, unknown>;
  updateMemberRole: UseMutationResult<
    { ok: boolean; role: string },
    Error,
    { membershipId: string; role: "owner" | "admin" | "member" },
    unknown
  >;
}) {
  if (row.kind === "invitation") {
    return <InvitationRow invitation={row.invitation} canManage={canManage} revokeInvite={revokeInvite} />;
  }

  const member = row.member;
  const displayName = member.name || member.email || member.userId;
  const subtitle = [member.email && member.name ? member.email : null, titleCase(member.status)]
    .filter(Boolean)
    .join(" · ");
  const targetIsOwner = member.role === "owner";
  const viewerIsOwner = viewerRole === "owner";
  // Admins manage members/admins; only an owner can edit or remove another owner.
  const canEditRole = canManage && (!targetIsOwner || viewerIsOwner);

  return (
    <div className="flex min-h-16 items-center gap-3 border-b border-[#eceeeb] px-3 py-3 last:border-b-0 sm:px-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#111217] text-sm font-semibold text-white">
        {initials(displayName)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-[#14151b]">{displayName}</div>
        <div className="truncate text-xs text-[#8a8d95]">{subtitle || member.userId}</div>
      </div>
      {canEditRole ? (
        <select
          value={member.role}
          disabled={updateMemberRole.isPending}
          onChange={event => {
            const next = event.target.value;
            updateMemberRole.mutate({
              membershipId: member.id,
              role: next === "owner" ? "owner" : next === "admin" ? "admin" : "member",
            });
          }}
          className="h-9 rounded-[10px] border border-[#dfe3dc] bg-white px-2 text-sm text-[#1c1d22] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9dddc7]/35"
          aria-label={`Role for ${displayName}`}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
          {viewerIsOwner ? <option value="owner">Owner</option> : null}
        </select>
      ) : (
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#8a8d95]">{titleCase(member.role)}</span>
      )}
      {canEditRole ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-[#8a8d95] hover:bg-[#fff3f1] hover:text-[#a64235]"
          disabled={removeMember.isPending}
          onClick={() => removeMember.mutate(member.id)}
          aria-label={`Remove ${displayName}`}
        >
          <Trash2 className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

function InvitationRow({
  invitation,
  canManage,
  revokeInvite,
}: {
  invitation: OrgInvitation;
  canManage: boolean;
  revokeInvite: UseMutationResult<{ ok: boolean }, Error, string, unknown>;
}) {
  return (
    <div className="flex min-h-16 items-center gap-3 border-b border-[#eceeeb] px-3 py-3 last:border-b-0 sm:px-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#e9f8f1] text-[#087d50]">
        <Mail className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-[#14151b]">{invitation.email}</div>
        <div className="truncate text-xs text-[#8a8d95]">
          Invite pending · {titleCase(invitation.role)}
        </div>
      </div>
      {canManage ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-[#8a8d95] hover:bg-[#fff3f1] hover:text-[#a64235]"
          disabled={revokeInvite.isPending}
          onClick={() => revokeInvite.mutate(invitation.id)}
          aria-label={`Revoke invite for ${invitation.email}`}
        >
          <Trash2 className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

function EmptyTeamState({ icon: Icon, title }: { icon: typeof Users; title: string }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-[#8a8d95]">
      <Icon className="size-5" />
      <div className="text-sm font-medium">{title}</div>
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <Label htmlFor={htmlFor} className="mb-2 text-sm font-semibold text-[#1c1d22]">
        {label}
      </Label>
      {children}
    </div>
  );
}

function initials(value: string): string {
  return value
    .split(/[.\s@_-]+/)
    .filter(Boolean)
    .map(part => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "M";
}

function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map(part => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
