import type { FormEvent } from "react";
import { useState } from "react";
import mentraLogo from "@/assets/mentra-logo.svg";

type LoginStep = "email" | "code";
type LoginStatus = "idle" | "loading" | "error";

export function LoginPage() {
  const initialAuthError = getAuthErrorMessage();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<LoginStep>("email");
  const [status, setStatus] = useState<LoginStatus>(initialAuthError ? "error" : "idle");
  const [message, setMessage] = useState<string | null>(initialAuthError);
  const postLoginTarget = getPostLoginTarget();
  const returnToUrl = getPostLoginReturnToUrl(postLoginTarget);

  async function onContinue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("loading");
    setMessage(null);

    try {
      if (step === "email") {
        const response = await postJson("/api/console/auth/magic/start", { email });
        if (!response.ok) throw new Error(await responseError(response));
        setStep("code");
        setMessage(`We sent a sign-in code to ${email.trim()}.`);
        setStatus("idle");
        return;
      }

      const response = await postJson("/api/console/auth/magic/verify", { email, code });
      if (!response.ok) throw new Error(await responseError(response));
      window.location.href = postLoginTarget;
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Sign in failed");
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f4f8f6_100%)] px-5 py-10 text-[#14141a]">
      <div className="pointer-events-none absolute left-[42%] top-[-54%] size-[980px] rounded-full bg-[radial-gradient(circle,rgba(201,244,232,0.78)_0%,rgba(228,246,240,0.46)_35%,rgba(255,255,255,0)_70%)] blur-[68px]" />
      <div className="pointer-events-none absolute left-[-24%] top-[58%] size-[720px] rounded-full bg-[radial-gradient(circle,rgba(214,242,235,0.68)_0%,rgba(232,247,242,0.4)_42%,rgba(255,255,255,0)_72%)] blur-[62px]" />

      <section className="relative flex w-full flex-col items-center justify-center gap-5">
        <div className="relative w-full max-w-[420px] overflow-hidden rounded-[24px] p-9 shadow-[0_16px_40px_-8px_rgba(20,20,26,0.07),0_0_0_1px_rgba(20,20,26,0.07),inset_0_1px_0_rgba(255,255,255,0.9)]">
          <div className="absolute inset-0 rounded-[24px] bg-[rgba(255,255,255,0.8)] backdrop-blur-[14px]" />
          <div className="relative">
            <img src={mentraLogo} alt="Mentra" className="mx-auto h-[27px] w-[50px]" />

            <div className="h-[22px]" />
            <h1 className="text-center font-display text-[22px] font-bold leading-[26px] tracking-[-0.44px] text-[#14141a]">
              Sign into Mentra Developer Console
            </h1>

            <div className="h-2" />
            <p className="font-body text-[13.5px] leading-[19px] text-[#7a7a82]">
              One account for the console, the CLI, and the store.
            </p>

            <div className="h-7" />
            <label className="font-display text-[11px] font-semibold uppercase leading-none tracking-[0.55px] text-[#b4b4ba]">
              Email
            </label>

            <div className="h-2" />
            <form onSubmit={onContinue}>
              <input
                className="h-[46px] w-full rounded-[12px] bg-white px-3.5 font-body text-sm text-[#14141a] shadow-[0_0_0_1px_#ececee] outline-none placeholder:text-[#9a9aa2] focus:shadow-[0_0_0_1px_#14141a,0_0_0_4px_rgba(20,20,26,0.06)]"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                aria-label="Email"
                autoComplete="email"
                disabled={step === "code" || status === "loading"}
              />

              {step === "code" ? (
                <>
                  <div className="h-3" />
                  <label className="font-display text-[11px] font-semibold uppercase leading-none tracking-[0.55px] text-[#b4b4ba]">
                    Code
                  </label>
                  <div className="h-2" />
                  <input
                    className="h-[46px] w-full rounded-[12px] bg-white px-3.5 text-center font-mono text-[17px] tracking-[0.28em] text-[#14141a] shadow-[0_0_0_1px_#ececee] outline-none placeholder:text-[#9a9aa2] focus:shadow-[0_0_0_1px_#14141a,0_0_0_4px_rgba(20,20,26,0.06)]"
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\s+/g, "").slice(0, 8))}
                    inputMode="numeric"
                    aria-label="Sign-in code"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    disabled={status === "loading"}
                  />
                </>
              ) : null}

              <div className="h-3" />
              <button
                type="submit"
                disabled={status === "loading" || (step === "email" ? !email.trim() : !code.trim())}
                className="flex h-[46px] w-full items-center justify-center rounded-full bg-[#14141a] px-[18px] font-display text-sm font-semibold text-white shadow-[0_18px_44px_-10px_rgba(20,20,26,0.25),inset_0_1px_0_rgba(255,255,255,0.14)] transition hover:bg-[#24242b] focus:outline-none focus:ring-4 focus:ring-[#14141a]/10 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {status === "loading" ? "Working..." : step === "email" ? "Continue" : "Verify code"}
              </button>
            </form>

            {message ? (
              <div
                className={`mt-3 rounded-[12px] px-3.5 py-2 font-body text-[11.5px] leading-4 ${
                  status === "error"
                    ? "bg-[#fff6f6] text-[#a23a3a] shadow-[0_0_0_1px_#f1d2d2]"
                    : "bg-[#f2fbf6] text-[#2b7a54] shadow-[0_0_0_1px_#d9efdf]"
                }`}
              >
                {message}
                {step === "code" && status !== "error" ? (
                  <button
                    type="button"
                    className="ml-1 font-display font-semibold text-[#14141a]"
                    onClick={() => {
                      setStep("email");
                      setCode("");
                      setMessage(null);
                    }}
                  >
                    Change email
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="h-[22px]" />
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-[#ececee]" />
              <span className="font-body text-xs leading-none text-[#9a9aa2]">or</span>
              <div className="h-px flex-1 bg-[#ececee]" />
            </div>

            <div className="h-[22px]" />
            <a
              href={`/api/console/auth/social/github?return_to=${encodeURIComponent(returnToUrl)}`}
              className="flex h-[46px] w-full items-center justify-center rounded-full bg-white px-[18px] font-display text-sm font-semibold text-[#5b5b63] shadow-[0_0_0_1px_#ececee] transition hover:bg-[#fbfbfc] focus:outline-none focus:ring-4 focus:ring-[#14141a]/5"
            >
              Continue with GitHub
            </a>

            <div className="h-2.5" />
            <a
              href={`/api/console/auth/social/google?return_to=${encodeURIComponent(returnToUrl)}`}
              className="flex h-[46px] w-full items-center justify-center rounded-full bg-white px-[18px] font-display text-sm font-semibold text-[#5b5b63] shadow-[0_0_0_1px_#ececee] transition hover:bg-[#fbfbfc] focus:outline-none focus:ring-4 focus:ring-[#14141a]/5"
            >
              Continue with Google
            </a>

            <div className="h-6" />
            <div className="font-body text-[11.5px] leading-4 text-[#a6a6ac]">
              <p>By continuing you agree to the MentraOS developer terms.</p>
              <p>No fees to build or publish.</p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 whitespace-normal text-center font-body text-[12.5px] leading-none text-[#9a9aa2] sm:whitespace-nowrap">
          <span>Signing in from the CLI?</span>
          <span className="font-mono text-xs font-medium text-[#5b5b63]">mentra login</span>
          <span>opens this page automatically.</span>
        </div>
      </section>
    </main>
  );
}

function getPostLoginTarget(): string {
  if (typeof window === "undefined") return "/dashboard";
  const returnTo = new URLSearchParams(window.location.search).get("returnTo");
  if (!returnTo) return "/dashboard";

  try {
    const url = returnTo.startsWith("/") && !returnTo.startsWith("//")
      ? new URL(returnTo, window.location.origin)
      : new URL(returnTo);
    if (url.origin !== window.location.origin) return "/dashboard";
    return `${url.pathname}${url.search}${url.hash}` || "/dashboard";
  } catch {
    return "/dashboard";
  }
}

function getPostLoginReturnToUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

function getAuthErrorMessage(): string | null {
  if (typeof window === "undefined") return null;
  const message = new URLSearchParams(window.location.search).get("auth_error");
  return message?.trim() || null;
}

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error_description?: string; error?: string; message?: string };
    return body.error_description || body.message || body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}
