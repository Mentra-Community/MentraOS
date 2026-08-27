import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Boxes } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { PackageName } from "@/components/package-name";
import { Badge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { sessionQuery } from "@/features/session/session.queries";
import { appsQuery } from "./apps.queries";

export function AppsPage() {
  const session = useQuery(sessionQuery());
  const apps = useQuery(appsQuery(session.isSuccess && !session.data.onboardingRequired));
  const appList = apps.data?.apps ?? [];
  const packagePrefix = session.data?.packagePrefix;

  return (
    <AppShell>
      <main className="mx-auto w-full max-w-[1040px] px-4 py-4 sm:px-5 sm:py-6 md:px-8 md:py-8">
        <Card className="overflow-hidden rounded-[16px] border-[#e0e4de] bg-white py-0 shadow-[0_1px_2px_rgba(20,21,27,0.06)] sm:rounded-[18px]">
          <CardHeader className="border-b border-[#eceeeb] px-4 py-4 sm:px-6 sm:py-5">
            <CardTitle className="font-display text-[19px]">Miniapps</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {apps.isPending ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center p-6 text-center text-sm text-[#747780] sm:min-h-[320px] sm:p-8">
                Loading miniapps…
              </div>
            ) : apps.isError && !apps.data ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center p-6 text-center sm:min-h-[320px] sm:p-8">
                <h2 className="font-display text-[21px] font-bold">Couldn’t load miniapps</h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-[#747780]">
                  {apps.error instanceof Error ? apps.error.message : "Something went wrong. Please try again."}
                </p>
              </div>
            ) : appList.length === 0 ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center p-6 text-center sm:min-h-[320px] sm:p-8">
                <div className="flex size-12 items-center justify-center rounded-[14px] bg-[#e9f8f1] text-[#087d50]">
                  <Boxes className="size-6" />
                </div>
                <h2 className="mt-5 font-display text-[21px] font-bold">No miniapps yet</h2>
                <p className="mt-2 max-w-md text-sm leading-6 text-[#747780]">
                  Package creation and signed release upload are CLI-only. Reserve the package, create and back up its
                  publisher key, then publish from your project.
                </p>
                <pre className="mt-6 max-w-full overflow-x-auto rounded-[12px] bg-[#111217] px-4 py-3 text-left font-mono text-xs leading-6 text-white sm:text-sm">
                  {`mentra miniapps create com.example.app --name 'My miniapp'
mentra miniapps keys create --package com.example.app
mentra publish`}
                </pre>
              </div>
            ) : (
              <div className="divide-y divide-[#eceeeb]">
                {appList.map(app => (
                  <Link
                    key={app.id}
                    to="/apps/$packageName"
                    params={{ packageName: app.packageName }}
                    className="grid gap-3 px-4 py-4 hover:bg-[#fafbfa] sm:px-6 md:grid-cols-[minmax(0,1fr)_120px_132px] md:items-center"
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
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </AppShell>
  );
}
