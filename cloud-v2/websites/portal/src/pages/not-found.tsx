import { useQuery } from "@tanstack/react-query";
import { buttonVariants, workspaceListQuery } from "@mentra/workspace-ui";
import { ArrowRight, Compass, Lock } from "lucide-react";
import { useBareWorkspaceId } from "@/components/portal-shell";
import { Link } from "@/lib/navigation";
import { portalWorkspaceApi } from "@/lib/portal";

/**
 * A workspace that does not exist or that the viewer may not see (Core does not say which, and neither do
 * we), or an address the portal does not have. Offers the way back to a workspace the viewer has.
 */
export function NotFoundMessage({ kind }: { kind: "workspace" | "page" }) {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const homeId = useBareWorkspaceId();
  const home = list.data?.find(item => item.workspaceId === homeId);
  const Icon = kind === "workspace" ? Lock : Compass;

  return (
    <section className="bg-card rounded-card mx-auto mt-6 max-w-[420px] border px-8 pt-10 pb-9 text-center md:mt-16">
      <div className="bg-surface text-muted-foreground mx-auto flex size-12 items-center justify-center rounded-full">
        <Icon className="size-5" />
      </div>
      <h1 className="mt-6 text-2xl leading-tight font-semibold">
        {kind === "workspace" ? "Workspace not found" : "Page not found"}
      </h1>
      <p className="text-muted-foreground mx-auto mt-3 max-w-[340px]">
        {kind === "workspace"
          ? "This workspace doesn't exist, or you don't have access to it. If you think you should, ask one of its admins to invite you."
          : "There is nothing at this address. Check the link, or go back to your workspaces."}
      </p>
      <Link
        href="/"
        className={buttonVariants({ size: "lg", className: "mt-7 w-full" })}
      >
        {home ? `Go to ${home.name}` : "Go to your workspaces"}
        <ArrowRight className="size-4" />
      </Link>
    </section>
  );
}
