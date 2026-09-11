import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isUnauthorizedError, redirectToConsoleLogin } from "@/api/http";
import { acceptOrgInvitation } from "./org.api";

// Cache the in-flight accept per token so StrictMode's double-mount reuses one
// request (single-use safe) while the live mount still receives the outcome.
const acceptRequests = new Map<string, ReturnType<typeof acceptOrgInvitation>>();

export function InviteAcceptPage() {
  const { token } = useParams({ from: "/invite/$token" });
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let request = acceptRequests.get(token);
    if (!request) {
      request = acceptOrgInvitation(token);
      acceptRequests.set(token, request);
    }
    request.then(
      () => {
        // Drop the resolved entry so a later re-visit can re-accept/refresh
        // rather than replaying a stale success from a long-lived session.
        acceptRequests.delete(token);
        if (!cancelled) navigate({ to: "/organization" });
      },
      (err) => {
        // Allow a retry (e.g. after signing in) rather than caching the failure.
        acceptRequests.delete(token);
        // Not signed in yet: bounce through login, then return here to accept.
        if (isUnauthorizedError(err)) {
          redirectToConsoleLogin();
          return;
        }
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "This invitation is invalid or has expired.");
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, navigate]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f6f7f5] px-4">
      <div className="w-full max-w-sm rounded-[18px] border border-[#e0e4de] bg-white p-8 text-center shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
        {error ? (
          <>
            <h1 className="font-display text-[18px] font-semibold text-[#14151b]">Invitation problem</h1>
            <p className="mt-2 text-sm leading-6 text-[#747780]">{error}</p>
            <a
              href="/"
              className="mt-5 inline-block rounded-full bg-[#111217] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#25262c]"
            >
              Go to console
            </a>
          </>
        ) : (
          <>
            <h1 className="font-display text-[18px] font-semibold text-[#14151b]">Accepting invitation…</h1>
            <p className="mt-2 text-sm leading-6 text-[#747780]">One moment while we add you to the organization.</p>
          </>
        )}
      </div>
    </main>
  );
}
