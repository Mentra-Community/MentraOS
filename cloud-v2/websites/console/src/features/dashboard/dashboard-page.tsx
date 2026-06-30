import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Boxes, Code2, KeyRound, PackagePlus } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PackageName } from "@/components/package-name";
import { Badge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { appsQuery } from "@/features/apps/apps.queries";
import { displayNameForUser } from "@/features/session/session.api";
import { sessionQuery } from "@/features/session/session.queries";
import { apiTokensQuery } from "@/features/tokens/tokens.queries";

const surfaceClass = "rounded-[18px] border-[#e0e4de] bg-white py-0 shadow-[0_1px_2px_rgba(20,21,27,0.06)]";

export function DashboardPage() {
  const session = useQuery(sessionQuery());
  const canLoadPrivateData = session.isSuccess && !session.data.onboardingRequired;
  const apps = useQuery(appsQuery(canLoadPrivateData));
  const tokens = useQuery(apiTokensQuery(canLoadPrivateData));
  const firstName = session.data?.user ? displayNameForUser(session.data.user).split(" ")[0] : "";
  const appList = apps.data?.apps ?? [];
  const packagePrefix = session.data?.packagePrefix;
  const tokenCount = tokens.data?.tokens.length ?? 0;

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-[1040px] px-4 py-5 sm:px-5 sm:py-6 md:px-8 md:py-8">
        <section className="mb-5 sm:mb-7">
          <p className="text-sm font-medium text-[#087d50]">Developer console</p>
          <h2 className="mt-2 font-display text-[28px] font-bold leading-tight text-[#14151b] md:text-[38px]">
            {firstName ? `Welcome back, ${firstName}` : "Welcome back"}
          </h2>
          <p className="mt-2 max-w-2xl text-[14px] leading-6 text-[#747780] sm:mt-3 sm:text-[15px]">
            Create miniapps, publish releases, and manage CLI access from one place.
          </p>
        </section>

        <section className="space-y-4">
          <Card className={surfaceClass}>
            <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
              <CardTitle className="font-display text-[19px]">Get started</CardTitle>
              <CardDescription className="mt-1 text-[13px] leading-5 sm:text-[14px]">
                The usual development loop.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 p-4 sm:p-5 lg:grid-cols-3">
              <ActionRow
                icon={PackagePlus}
                title="Your miniapps"
                body="Browse packages, releases, and review status. New miniapps are created with the CLI."
                action="Open miniapps"
                to="/apps"
                primary
              />
              <ActionRow
                icon={Code2}
                title="Use the CLI"
                body="Run mentra login locally, then publish from your project."
                action="CLI login"
                to="/tokens"
              />
              <ActionRow
                icon={KeyRound}
                title="API keys"
                body={tokenCount === 0 ? "Create keys later for CI/CD automation." : `${tokenCount} key${tokenCount === 1 ? "" : "s"} ready for automation.`}
                action="Manage keys"
                to="/tokens"
              />
            </CardContent>
          </Card>

          <Card className={surfaceClass}>
            <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
              <div className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
                <div>
                  <CardTitle className="font-display text-[19px]">Miniapps</CardTitle>
                  <CardDescription className="mt-1 text-[13px] leading-5 sm:text-[14px]">
                    {appList.length === 0 ? "No miniapps have been created for this org yet." : `${appList.length} miniapp${appList.length === 1 ? "" : "s"} in this org.`}
                  </CardDescription>
                </div>
                {appList.length > 0 ? (
                  <Button variant="ghost" className="h-9 rounded-full px-3 text-[#087d50]" asChild>
                    <Link to="/apps">
                      View all
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {appList.length === 0 ? (
                <div className="flex min-h-[300px] flex-col items-center justify-center p-6 text-center">
                  <div className="flex size-12 items-center justify-center rounded-[14px] bg-[#e9f8f1] text-[#087d50]">
                    <Boxes className="size-6" />
                  </div>
                  <h3 className="mt-5 font-display text-[21px] font-bold">No miniapps yet</h3>
                  <p className="mt-2 max-w-md text-sm leading-6 text-[#747780]">
                    Create your first miniapp record, then use the CLI to bundle and publish releases.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-[#eceeeb]">
                  {appList.slice(0, 5).map(app => (
                    <div
                      key={app.id}
                      className="grid gap-3 px-4 py-4 sm:px-6 md:grid-cols-[minmax(0,1fr)_112px_116px] md:items-center"
                    >
                      <div className="min-w-0">
                        <div className="text-[15px] font-semibold text-[#1c1d22]">{app.name}</div>
                        <div className="mt-1 truncate">
                          <PackageName packageName={app.packageName} packagePrefix={packagePrefix} />
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3 md:contents">
                        <div className="justify-self-start">
                          <Badge tone={app.status === "active" ? "success" : "neutral"}>{app.status}</Badge>
                        </div>
                        <div className="text-right">
                          <div className="font-mono text-xs text-[#8a8d95]">
                            {app.activeRelease?.version ?? app.latestRelease?.version ?? "no releases"}
                          </div>
                          {app.latestRelease ? (
                            <div className="mt-1 text-[11px] uppercase tracking-[0.08em] text-[#a0a3aa]">
                              {app.latestRelease.status.replace("_", " ")}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </main>
    </AppShell>
  );
}

type ActionRowProps = {
  icon: typeof PackagePlus;
  title: string;
  body: string;
  action: string;
  to: "/apps" | "/tokens";
  primary?: boolean;
};

function ActionRow({ icon: Icon, title, body, action, to, primary = false }: ActionRowProps) {
  return (
    <div className="flex min-h-[190px] flex-col rounded-[14px] bg-[#f6f7f5] p-4 sm:p-5">
      <div className="flex size-11 shrink-0 items-center justify-center rounded-[12px] bg-white text-[#087d50] shadow-[0_0_0_1px_#e0e4de]">
        <Icon className="size-5" />
      </div>
      <div className="mt-4 font-display text-[17px] font-semibold text-[#14151b]">{title}</div>
      <p className="mt-1 text-sm leading-6 text-[#747780]">{body}</p>
      <Button
        variant={primary ? "default" : "ghost"}
        className={
          primary
            ? "mt-auto h-10 self-start rounded-full bg-[#111217] px-5 text-white hover:bg-[#25262c]"
            : "mt-auto h-9 self-start rounded-full px-0 text-[#087d50] hover:bg-transparent"
        }
        asChild
      >
        <Link to={to}>
          {action}
          {!primary ? <ArrowUpRight className="size-4" /> : null}
        </Link>
      </Button>
    </div>
  );
}
