import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { Code2, PackagePlus, UploadCloud } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { PackageName } from "@/components/package-name";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createDeveloperApp } from "@/features/apps/apps.api";
import { sessionQuery } from "@/features/session/session.queries";

export function PublishPage() {
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery());
  const packagePrefix = session.data?.packagePrefix?.replace(/\.+$/, "") ?? "";
  const [packageSuffix, setPackageSuffix] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const createApp = useMutation({
    mutationFn: createDeveloperApp,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["developer-apps"] });
    },
  });

  const normalizedPackageSuffix = normalizePackageSuffix(packageSuffix, packagePrefix);
  const packageName = `${packagePrefix}.${normalizedPackageSuffix}`;
  const canSubmit = packagePrefix.length > 0 && normalizedPackageSuffix.length > 0 && displayName.trim().length > 0 && !createApp.isPending;

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-[880px] px-4 py-4 sm:px-5 sm:py-6 md:px-8 md:py-8">
        {!packagePrefix ? (
          <Card className="rounded-[16px] border-[#e0e4de] bg-white py-0 shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
            <CardContent className="p-5 sm:p-6">
              <div className="font-display text-[20px] font-semibold">Create your developer org first</div>
              <p className="mt-2 text-sm leading-6 text-[#747780]">
                Miniapps need an org package prefix before package names can be reserved.
              </p>
              <Button className="mt-5 h-10 rounded-full bg-[#111217] px-5 text-white hover:bg-[#25262c]" asChild>
                <Link to="/organization">Set up organization</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
        <Card className="rounded-[16px] border-[#e0e4de] bg-white py-0 shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
          <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
            <CardTitle className="font-display text-[19px]">Create miniapp</CardTitle>
            <CardDescription className="mt-1 text-[13px] leading-5 sm:text-[14px]">
              Reserve package identity, then use the CLI to publish versioned release bundles.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 p-4 sm:gap-6 sm:p-6 lg:grid-cols-[1fr_300px]">
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canSubmit) return;
                createApp.mutate({
                  packageName,
                  displayName: displayName.trim(),
                  description: description.trim() || null,
                });
              }}
            >
              <Field id="packageName" label="Package name">
                <div className="flex h-11 overflow-hidden rounded-[12px] border border-[#dfe3dc] bg-white focus-within:ring-3 focus-within:ring-[#9dddc7]/35">
                  <div className="flex shrink-0 items-center border-r border-[#e8ebe6] bg-[#f6f7f5] px-3 font-mono text-xs text-[#747780] sm:px-4 sm:text-sm">
                    {packagePrefix}.
                  </div>
                  <Input
                    id="packageName"
                    className="h-full min-w-0 rounded-none border-0 bg-transparent px-3 font-mono text-sm shadow-none focus-visible:ring-0 sm:px-4"
                    placeholder="myminiapp"
                    value={packageSuffix}
                    onChange={event => setPackageSuffix(stripPackagePrefix(event.target.value, packagePrefix))}
                  />
                </div>
                <div className="mt-2 text-xs leading-5 text-[#8a8d95]">
                  This org can publish package names under <PackageName packageName={`${packagePrefix}.example`} packagePrefix={packagePrefix} />.
                </div>
              </Field>
              <Field id="displayName" label="Display name">
                <Input
                  id="displayName"
                  className="h-11 rounded-[12px] border-[#dfe3dc] bg-white px-3 shadow-none focus-visible:ring-[#9dddc7]/35 sm:px-4"
                  placeholder="My miniapp"
                  value={displayName}
                  onChange={event => setDisplayName(event.target.value)}
                />
              </Field>
              <Field id="description" label="Description">
                <Input
                  id="description"
                  className="h-11 rounded-[12px] border-[#dfe3dc] bg-white px-3 shadow-none focus-visible:ring-[#9dddc7]/35 sm:px-4"
                  placeholder="Short internal description"
                  value={description}
                  onChange={event => setDescription(event.target.value)}
                />
              </Field>
              {createApp.isError ? (
                <div className="rounded-[12px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
                  {createApp.error instanceof Error ? createApp.error.message : "Could not create miniapp."}
                </div>
              ) : null}
              {createApp.isSuccess ? (
                <div className="rounded-[12px] bg-[#edf8f2] px-4 py-3 text-sm text-[#087d50]">
                  Miniapp reserved. Publish the first release with `mentra publish`.
                </div>
              ) : null}
              <Button className="h-10 w-full rounded-full bg-[#111217] px-5 text-white hover:bg-[#25262c] sm:w-auto" disabled={!canSubmit}>
                {createApp.isPending ? "Creating..." : "Create miniapp"}
              </Button>
            </form>

            <div className="space-y-3">
              <PublishStep icon={PackagePlus} title="Reserve package identity" body="Package names are stable ownership records." />
              <PublishStep icon={Code2} title="Build locally" body="Run `mentra publish` from a miniapp folder." />
              <PublishStep icon={UploadCloud} title="Upload release bundle" body="The CLI uploads the installable bundle zip for review and distribution." />
            </div>
          </CardContent>
        </Card>
        )}
      </main>
    </AppShell>
  );
}

function stripPackagePrefix(value: string, packagePrefix: string): string {
  const normalized = value.trim().toLowerCase();
  const prefixWithDot = `${packagePrefix.toLowerCase().replace(/\.+$/, "")}.`;
  return normalized.startsWith(prefixWithDot)
    ? normalized.slice(prefixWithDot.length)
    : normalized.replace(/^\.+/, "");
}

function normalizePackageSuffix(value: string, packagePrefix: string): string {
  return stripPackagePrefix(value, packagePrefix).replace(/\.+$/, "");
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <label className="block" htmlFor={id}>
      <span className="mb-2 block text-sm font-semibold text-[#1c1d22]">{label}</span>
      {children}
    </label>
  );
}

type PublishStepProps = {
  icon: typeof PackagePlus;
  title: string;
  body: string;
};

function PublishStep({ icon: Icon, title, body }: PublishStepProps) {
  return (
    <div className="flex gap-3 rounded-[14px] bg-[#f6f7f5] p-3.5 sm:p-4">
      <Icon className="mt-0.5 size-4 shrink-0 text-[#087d50]" />
      <div>
        <div className="text-sm font-semibold">{title}</div>
        <div className="mt-1 text-sm leading-5 text-[#747780] sm:leading-6">{body}</div>
      </div>
    </div>
  );
}
