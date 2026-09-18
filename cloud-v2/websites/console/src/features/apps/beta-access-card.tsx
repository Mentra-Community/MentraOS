import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Trash2, Users } from "lucide-react";
import { Badge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getBetaAccess, inviteBetaTester, revokeBetaInvitation, updateBetaAccess } from "./apps.api";

export function BetaAccessCard({ packageName }: { packageName: string }) {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const queryKey = ["beta-access", packageName];
  const access = useQuery({ queryKey, queryFn: () => getBetaAccess(packageName) });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey }),
      client.invalidateQueries({ queryKey: ["developer-releases", packageName] }),
      client.invalidateQueries({ queryKey: ["developer-apps"] }),
    ]);
  };
  const setMode = useMutation({
    mutationFn: (mode: "private" | "public") => updateBetaAccess(packageName, mode),
    onSuccess: refresh,
  });
  const invite = useMutation({
    mutationFn: (inviteEmail: string) => inviteBetaTester(packageName, inviteEmail),
    onSuccess: () => {
      setEmail("");
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (invitationId: string) => revokeBetaInvitation(packageName, invitationId),
    onSuccess: refresh,
  });
  const mode = access.data?.mode ?? "private";
  const error = access.error ?? setMode.error ?? invite.error ?? revoke.error;

  return (
    <Card className="mt-6 rounded-[16px] border-[#e0e4de] bg-white shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
      <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="font-display text-[18px]">Beta testing</CardTitle>
            <CardDescription className="mt-1 max-w-2xl text-sm leading-6">
              Private betas are visible only to invited Mentra accounts. Public betas add an opt-in button to the Store.
            </CardDescription>
          </div>
          <Badge tone={mode === "public" ? "warn" : "neutral"}>{mode}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Beta access mode">
          {(["private", "public"] as const).map(candidate => (
            <Button
              key={candidate}
              type="button"
              variant={mode === candidate ? "default" : "outline"}
              className={mode === candidate ? "rounded-full bg-[#111217] text-white" : "rounded-full"}
              disabled={access.isLoading || setMode.isPending || mode === candidate}
              onClick={() => setMode.mutate(candidate)}>
              {candidate === "private" ? "Private beta" : "Public beta"}
            </Button>
          ))}
        </div>

        {mode === "private" ? (
          <>
            <form
              className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
              onSubmit={event => {
                event.preventDefault();
                const normalized = email.trim().toLowerCase();
                if (normalized) invite.mutate(normalized);
              }}>
              <div>
                <Label htmlFor={`beta-email-${packageName}`}>Invite a tester</Label>
                <Input
                  id={`beta-email-${packageName}`}
                  type="email"
                  className="mt-2 h-10 rounded-[11px]"
                  placeholder="tester@example.com"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                />
              </div>
              <Button
                className="h-10 rounded-full bg-[#111217] px-5 text-white"
                disabled={invite.isPending || !email.trim()}>
                <Mail className="size-4" />
                {invite.isPending ? "Inviting…" : "Invite"}
              </Button>
            </form>
            <p className="text-xs leading-5 text-[#8a8d95]">
              Testers must already have a verified Mentra account with this email. Invitations expire after 30 days if unused.
            </p>

            <div className="overflow-hidden rounded-[13px] border border-[#e5e8e3]">
              {access.isLoading ? (
                <div className="p-4 text-sm text-[#747780]">Loading testers…</div>
              ) : access.data?.invitations.length ? (
                <div className="divide-y divide-[#eceeeb]">
                  {access.data.invitations.map(invitation => (
                    <div key={invitation.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[#1c1d22]">{invitation.email}</div>
                        <div className="mt-0.5 text-xs text-[#8a8d95]">
                          {invitation.state === "accepted" ? "Beta tester" : "Invitation pending"}
                        </div>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={revoke.isPending}
                        aria-label={`Revoke beta access for ${invitation.email}`}
                        onClick={() => revoke.mutate(invitation.id)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-3 p-4 text-sm text-[#747780]">
                  <Users className="size-4" /> No beta testers invited yet.
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="rounded-[13px] bg-[#fff8e8] p-4 text-sm leading-6 text-[#765613]">
            Anyone signed into the Mentra Miniapp Store can join this beta. Existing private invitations remain saved if you switch back.
          </div>
        )}

        {error ? (
          <div className="rounded-[12px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
            {error instanceof Error ? error.message : "Could not update beta access."}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
