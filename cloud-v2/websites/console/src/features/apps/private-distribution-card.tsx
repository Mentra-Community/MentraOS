import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, LockKeyhole, Mail, Trash2, Users } from "lucide-react";
import { Badge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getMiniappAccess,
  inviteMiniappUser,
  revokeMiniappAccess,
  updateMiniappVisibility,
} from "./apps.api";

export function PrivateDistributionCard({ packageName }: { packageName: string }) {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const queryKey = ["miniapp-access", packageName];
  const access = useQuery({ queryKey, queryFn: () => getMiniappAccess(packageName) });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey }),
      client.invalidateQueries({ queryKey: ["developer-apps"] }),
      client.invalidateQueries({ queryKey: ["developer-releases", packageName] }),
    ]);
  };
  const setVisibility = useMutation({
    mutationFn: (visibility: "public" | "private") => updateMiniappVisibility(packageName, visibility),
    onSuccess: refresh,
  });
  const invite = useMutation({
    mutationFn: (inviteEmail: string) => inviteMiniappUser(packageName, inviteEmail),
    onSuccess: () => {
      setEmail("");
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (invitationId: string) => revokeMiniappAccess(packageName, invitationId),
    onSuccess: refresh,
  });
  const visibility = access.data?.visibility ?? "public";
  const error = access.error ?? setVisibility.error ?? invite.error ?? revoke.error;

  return (
    <Card className="mt-6 rounded-[16px] border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
      <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="font-display text-[18px]">Distribution</CardTitle>
            <CardDescription className="mt-1 max-w-2xl text-sm leading-6">
              Public miniapps require Mentra review. Private miniapps are available only to invited Mentra accounts and publish after automated validation.
            </CardDescription>
          </div>
          <Badge tone={visibility === "private" ? "neutral" : "success"}>{visibility}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Miniapp visibility">
          <Button
            type="button"
            variant={visibility === "public" ? "default" : "outline"}
            className={visibility === "public" ? "rounded-full bg-[#111217] text-white" : "rounded-full"}
            disabled={access.isLoading || setVisibility.isPending || visibility === "public"}
            onClick={() => setVisibility.mutate("public")}>
            <Eye className="size-4" /> Public
          </Button>
          <Button
            type="button"
            variant={visibility === "private" ? "default" : "outline"}
            className={visibility === "private" ? "rounded-full bg-[#111217] text-white" : "rounded-full"}
            disabled={access.isLoading || setVisibility.isPending || visibility === "private"}
            onClick={() => setVisibility.mutate("private")}>
            <LockKeyhole className="size-4" /> Private
          </Button>
        </div>

        {visibility === "private" ? (
          <>
            <form
              className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
              onSubmit={event => {
                event.preventDefault();
                const normalized = email.trim().toLowerCase();
                if (normalized) invite.mutate(normalized);
              }}>
              <div>
                <Label htmlFor={`private-access-email-${packageName}`}>Invite a user</Label>
                <Input
                  id={`private-access-email-${packageName}`}
                  type="email"
                  className="mt-2 h-10 rounded-[11px]"
                  placeholder="user@example.com"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                />
              </div>
              <Button className="h-10 rounded-full bg-[#111217] px-5 text-white" disabled={invite.isPending || !email.trim()}>
                <Mail className="size-4" /> {invite.isPending ? "Inviting…" : "Invite"}
              </Button>
            </form>
            <p className="text-xs leading-5 text-[#8a8d95]">
              Users must already have a verified Mentra account. Private access controls Store discovery, installation, and updates.
            </p>
            <div className="overflow-hidden rounded-[13px] border border-[#e5e8e3]">
              {access.isLoading ? (
                <div className="p-4 text-sm text-[#747780]">Loading users…</div>
              ) : access.data?.invitations.length ? (
                <div className="divide-y divide-[#eceeeb]">
                  {access.data.invitations.map(invitation => (
                    <div key={invitation.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[#1c1d22]">{invitation.email}</div>
                        <div className="mt-0.5 text-xs text-[#8a8d95]">
                          {invitation.state === "accepted" ? "Has access" : "Invitation pending"}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={revoke.isPending}
                        aria-label={`Revoke private access for ${invitation.email}`}
                        onClick={() => revoke.mutate(invitation.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-3 p-4 text-sm text-[#747780]">
                  <Users className="size-4" /> No users invited yet.
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="rounded-[13px] bg-[#eef8f2] p-4 text-sm leading-6 text-[#276044]">
            Published releases are searchable by everyone after Mentra review. Switching a privately published release to public never bypasses review.
          </div>
        )}

        {error ? (
          <div className="rounded-[12px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
            {error instanceof Error ? error.message : "Could not update private distribution."}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
