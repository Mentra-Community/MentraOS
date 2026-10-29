import { LogOut } from "lucide-react";
import mentraLogo from "../assets/mentra-logo.svg";

/**
 * After signing out of the admin portal when Core gave no Mentra account
 * sign-out to go to (lib/session): the admin portal session has ended and
 * there is nothing else to do here.
 */
export function SignedOutScreen() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f4f8f6_100%)] px-5 py-10 text-[#14141a]">
      <section className="relative w-full max-w-[420px] rounded-[24px] bg-white/90 p-9 text-center shadow-[0_16px_40px_-8px_rgba(20,20,26,0.07),0_0_0_1px_rgba(20,20,26,0.07)]">
        <img src={mentraLogo} alt="Mentra" className="mx-auto h-[27px] w-[50px]" />
        <div className="h-[22px]" />
        <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-[#f0faf5] text-[#087d50]">
          <LogOut className="size-5" />
        </div>
        <div className="h-[18px]" />
        <h1 className="font-display text-[26px] font-bold leading-[30px] tracking-[-0.52px]">Signed out of the admin portal</h1>
        <div className="h-2.5" />
        <p className="mx-auto max-w-[300px] font-body text-[13.5px] leading-[20px] text-[#7a7a82]">You can close this tab.</p>
        <div className="h-8" />
        <a
          className="flex h-[48px] w-full items-center justify-center rounded-full bg-[#14141a] px-[18px] font-display text-sm font-semibold text-white transition hover:bg-[#24242b] focus:outline-none focus:ring-4 focus:ring-[#14141a]/10"
          href="/"
        >
          Sign in again
        </a>
      </section>
    </main>
  );
}
