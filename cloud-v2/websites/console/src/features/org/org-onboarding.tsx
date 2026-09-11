import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Mail, PackagePlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PackageName } from "@/components/package-name";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sessionQuery } from "@/features/session/session.queries";
import { saveDeveloperOrg } from "./org.api";
import { isValidPackagePrefix, normalizePackagePrefix, suggestedOrgDefaults } from "./org-helpers";

/**
 * The onboarding step shown inside OnboardingShell when a developer has no org.
 * Offers the two real paths — create a new org, or wait for an invite to an
 * existing one — instead of dumping the user on a half-gated dashboard.
 */
export function DevOnboarding() {
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery());
  const user = session.data?.user;
  const email = user?.email ?? "your email";
  const suggested = useMemo(() => suggestedOrgDefaults(user), [user]);

  const [touched, setTouched] = useState(false);
  const [displayName, setDisplayName] = useState(suggested.displayName);
  const [packagePrefix, setPackagePrefix] = useState(suggested.packagePrefix);

  // Keep the form pre-filled with suggestions until the developer edits it (the
  // session — and thus the suggested defaults — resolves after first render).
  useEffect(() => {
    if (touched) return;
    setDisplayName(suggested.displayName);
    setPackagePrefix(suggested.packagePrefix);
  }, [suggested.displayName, suggested.packagePrefix, touched]);

  const create = useMutation({
    mutationFn: saveDeveloperOrg,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["console-session"] }),
        queryClient.invalidateQueries({ queryKey: ["developer-org"] }),
        queryClient.invalidateQueries({ queryKey: ["developer-apps"] }),
      ]);
    },
  });

  const normalizedPrefix = normalizePackagePrefix(packagePrefix);
  const previewPackageName = normalizedPrefix ? `${normalizedPrefix}.weather` : "io.acme.weather";
  const canCreate = displayName.trim().length >= 2 && isValidPackagePrefix(normalizedPrefix) && !create.isPending;

  return (
    <div className="space-y-7">
      <div>
        <div className="inline-flex items-center gap-2 rounded-full border border-[#dfe3dc] bg-white px-3 py-1 text-xs font-medium text-[#5d6068]">
          <Building2 className="size-3.5 text-[#087d50]" />
          Step 1 of 1 · Set up your organization
        </div>
        <h1 className="mt-4 font-display text-[28px] font-bold leading-tight text-[#14151b]">
          Create your developer organization
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[#68746d]">
          Every miniapp lives under an organization that owns a unique package prefix. Create one now, or wait for a
          teammate to invite you — the console unlocks as soon as you belong to an org.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        {/* Create */}
        <section className="rounded-[18px] border border-[#e0e4de] bg-white p-6 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
          <h2 className="font-display text-[19px] font-bold">Create a new org</h2>
          <p className="mt-1 text-sm leading-6 text-[#747780]">Your org owns a unique package prefix. Every miniapp you create lives under it.</p>

          <div className="mt-5 rounded-[14px] bg-[#f1faf5] p-4 text-sm leading-6 text-[#2f6b50]">
            Pick a namespace now so package names cannot drift into <span className="font-mono">com.google.*</span> or another org's space. Public store review can verify domain or brand ownership later.
          </div>

          <form
            className="mt-5 grid gap-5 md:grid-cols-2"
            onSubmit={event => {
              event.preventDefault();
              if (canCreate) create.mutate({ displayName: displayName.trim(), packagePrefix: normalizedPrefix });
            }}
          >
            <div>
              <Label htmlFor="org-name" className="mb-2 text-sm font-semibold text-[#1c1d22]">Organization name</Label>
              <Input
                id="org-name"
                value={displayName}
                onChange={event => { setTouched(true); setDisplayName(event.target.value); }}
                placeholder="Acme Labs"
                className="h-11 rounded-[12px] bg-white"
              />
            </div>
            <div>
              <Label htmlFor="org-prefix" className="mb-2 text-sm font-semibold text-[#1c1d22]">Package prefix</Label>
              <Input
                id="org-prefix"
                value={packagePrefix}
                onChange={event => { setTouched(true); setPackagePrefix(event.target.value.toLowerCase()); }}
                placeholder="io.acme"
                className="h-11 rounded-[12px] bg-white font-mono"
              />
              <p className="mt-1.5 text-xs leading-5 text-[#8a8d95]">
                Lowercase reverse-DNS. Reserved prefixes like <span className="font-mono">com.mentra</span> cannot be claimed unless your account is allowed to own them.
              </p>
            </div>

            <div className="md:col-span-2 rounded-[14px] bg-[#f7f8f6] p-4">
              <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#a0a3aa]">Miniapp package preview</div>
              <div className="mt-1.5">
                <PackageName packageName={previewPackageName} packagePrefix={normalizedPrefix || undefined} />
              </div>
              <p className="mt-2 text-sm leading-6 text-[#747780]">
                Developers only choose the suffix, like <span className="font-mono">weather</span>; the org prefix is added and enforced automatically.
              </p>
            </div>

            <div className="md:col-span-2">
              {create.isError ? (
                <div className="mb-3 rounded-[12px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
                  {create.error instanceof Error ? create.error.message : "Could not create organization"}
                </div>
              ) : null}
              <Button
                type="submit"
                disabled={!canCreate}
                className="h-11 rounded-full bg-[#111217] px-6 text-white hover:bg-[#25262c] disabled:opacity-60"
              >
                <PackagePlus className="size-4" />
                {create.isPending ? "Creating..." : "Create organization"}
              </Button>
            </div>
          </form>
        </section>

        {/* Join */}
        <section className="space-y-4">
          <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
            <div className="flex size-10 items-center justify-center rounded-[12px] bg-[#eef2ff] text-[#3a55c8]">
              <Mail className="size-5" />
            </div>
            <h3 className="mt-3 font-display text-[16px] font-bold">Join an existing org</h3>
            <p className="mt-1.5 text-sm leading-6 text-[#747780]">
              Already have a team on MentraOS? Ask an owner to invite <span className="font-medium text-[#1c1d22]">{email}</span>. Once they send it, the invite appears here automatically and you can accept it.
            </p>
          </div>
          <div className="rounded-[18px] border border-[#e0e4de] bg-white p-5 shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
            <h3 className="font-display text-[16px] font-bold">Why an org first?</h3>
            <p className="mt-1.5 text-sm leading-6 text-[#747780]">
              Miniapp package names are permanent and org-scoped. Choosing a namespace before you publish keeps package identity stable and trustworthy.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
