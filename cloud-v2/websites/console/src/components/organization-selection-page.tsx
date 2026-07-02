import { Building2, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import mentraLogo from "@/assets/mentra-logo.svg";

const organizationSelectionSchema = z.object({
  organizations: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })),
  returnTo: z.string().nullable(),
});

type OrganizationSelection = z.infer<typeof organizationSelectionSchema>;

type SelectionStatus = "loading" | "ready" | "submitting" | "error";

export function OrganizationSelectionPage() {
  const [selection, setSelection] = useState<OrganizationSelection | null>(null);
  const [status, setStatus] = useState<SelectionStatus>("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSelection() {
      try {
        const response = await fetch("/api/console/auth/organization-selection", {
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error(await responseError(response));
        const parsed = organizationSelectionSchema.parse(await response.json());
        if (cancelled) return;
        setSelection(parsed);
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Sign-in expired. Please try again.");
      }
    }

    void loadSelection();
    return () => {
      cancelled = true;
    };
  }, []);

  async function chooseOrganization(organizationId: string) {
    setStatus("submitting");
    setMessage(null);

    try {
      const response = await fetch("/api/console/auth/organization-selection", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const body = await response.json() as { redirectTo?: string };
      window.location.href = body.redirectTo || selection?.returnTo || "/dashboard";
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not complete sign-in.");
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f4f8f6_100%)] px-5 py-10 text-[#14141a]">
      <div className="pointer-events-none absolute left-[42%] top-[-54%] size-[980px] rounded-full bg-[radial-gradient(circle,rgba(201,244,232,0.78)_0%,rgba(228,246,240,0.46)_35%,rgba(255,255,255,0)_70%)] blur-[68px]" />
      <div className="pointer-events-none absolute left-[-24%] top-[58%] size-[720px] rounded-full bg-[radial-gradient(circle,rgba(214,242,235,0.68)_0%,rgba(232,247,242,0.4)_42%,rgba(255,255,255,0)_72%)] blur-[62px]" />

      <section className="relative flex w-full max-w-[430px] flex-col items-center justify-center gap-5">
        <div className="relative w-full overflow-hidden rounded-[24px] p-9 shadow-[0_16px_40px_-8px_rgba(20,20,26,0.07),0_0_0_1px_rgba(20,20,26,0.07),inset_0_1px_0_rgba(255,255,255,0.9)]">
          <div className="absolute inset-0 rounded-[24px] bg-[rgba(255,255,255,0.8)] backdrop-blur-[14px]" />
          <div className="relative">
            <img src={mentraLogo} alt="Mentra" className="mx-auto h-[27px] w-[50px]" />

            <div className="h-[22px]" />
            <h1 className="text-center font-display text-[22px] font-bold leading-[26px] text-[#14141a]">
              Choose an organization
            </h1>

            <div className="h-2" />
            <p className="text-center font-body text-[13.5px] leading-[19px] text-[#7a7a82]">
              Your account belongs to more than one WorkOS organization. Pick the developer org for this session.
            </p>

            <div className="h-7" />
            {status === "loading" ? (
              <div className="rounded-[16px] bg-white px-4 py-4 text-center font-body text-sm text-[#7a7a82] shadow-[0_0_0_1px_#ececee]">
                Loading organizations...
              </div>
            ) : null}

            {selection?.organizations.length ? (
              <div className="space-y-2.5">
                {selection.organizations.map(org => (
                  <button
                    key={org.id}
                    type="button"
                    disabled={status === "submitting"}
                    onClick={() => void chooseOrganization(org.id)}
                    className="flex w-full items-center gap-3 rounded-[16px] bg-white px-4 py-3 text-left shadow-[0_0_0_1px_#ececee] transition hover:bg-[#fbfbfc] focus:outline-none focus:ring-4 focus:ring-[#14141a]/5 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-[12px] bg-[#edf8f3] text-[#0b8d5b]">
                      <Building2 size={19} strokeWidth={2.2} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-display text-[14.5px] font-semibold text-[#14141a]">
                        {org.name}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-[#9a9aa2]">{org.id}</span>
                    </span>
                    <ChevronRight className="shrink-0 text-[#9a9aa2]" size={18} />
                  </button>
                ))}
              </div>
            ) : null}

            {message ? (
              <div className="mt-3 rounded-[12px] bg-[#fff6f6] px-3.5 py-2 font-body text-[11.5px] leading-4 text-[#a23a3a] shadow-[0_0_0_1px_#f1d2d2]">
                {message}
              </div>
            ) : null}

            {status === "error" ? (
              <a
                href="/"
                className="mt-4 flex h-[46px] w-full items-center justify-center rounded-full bg-[#14141a] px-[18px] font-display text-sm font-semibold text-white shadow-[0_18px_44px_-10px_rgba(20,20,26,0.25),inset_0_1px_0_rgba(255,255,255,0.14)] transition hover:bg-[#24242b] focus:outline-none focus:ring-4 focus:ring-[#14141a]/10"
              >
                Start over
              </a>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_description?: string; error?: string; message?: string };
    return body.error_description || body.message || body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
