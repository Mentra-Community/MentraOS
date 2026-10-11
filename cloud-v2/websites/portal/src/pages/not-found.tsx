import { useQuery } from "@tanstack/react-query";
import { workspaceListQuery } from "@mentra/workspace-ui";
import { ArrowRight, Compass, Lock } from "lucide-react";
import { safeLocalStorage } from "@/lib/api";
import { Link } from "@/lib/navigation";
import { portalWorkspaceApi } from "@/lib/portal";
import { homeWorkspace, recallWorkspace, workspacePath } from "@/lib/routes";

/**
 * A workspace that does not exist or that the viewer may not see (Core does not say which, and neither do
 * we), or an address the portal does not have. Offers the way back to a workspace the viewer has.
 */
export function NotFoundMessage({ kind }: { kind: "workspace" | "page" }) {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const homeId = list.data ? homeWorkspace(list.data, recallWorkspace(safeLocalStorage())) : null;
  const home = list.data?.find(item => item.workspaceId === homeId);
  const Icon = kind === "workspace" ? Lock : Compass;

  return (
    <section className="mx-auto mt-6 max-w-[440px] rounded-[24px] border border-[#e0e4de] bg-white p-8 text-center shadow-[0_16px_40px_-12px_rgba(20,21,27,0.12)] md:mt-16">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-[#f0f2ef] text-[#5d6068]">
        <Icon className="size-5" />
      </div>
      <h1 className="mt-5 font-display text-[22px] font-bold leading-7 tracking-[-0.3px]">
        {kind === "workspace" ? "Workspace not found" : "Page not found"}
      </h1>
      <p className="mx-auto mt-2 max-w-[340px] text-sm leading-6 text-[#68746d]">
        {kind === "workspace"
          ? "This workspace doesn't exist, or you don't have access to it. If you think you should, ask one of its admins to invite you."
          : "There is nothing at this address. Check the link, or go back to your workspaces."}
      </p>
      <Link
        href={home ? workspacePath(home.workspaceId) : "/"}
        className="mt-6 inline-flex h-10 items-center gap-2 rounded-full bg-[#111217] px-5 text-sm font-semibold text-white transition hover:bg-[#25262c]"
      >
        {home ? `Go to ${home.name}` : "Go to your workspaces"}
        <ArrowRight className="size-4" />
      </Link>
    </section>
  );
}
