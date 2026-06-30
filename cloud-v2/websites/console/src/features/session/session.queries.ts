import { queryOptions } from "@tanstack/react-query";
import { getConsoleSession } from "./session.api";

export const sessionQuery = () =>
  queryOptions({
    queryKey: ["console-session"],
    queryFn: getConsoleSession,
    retry: false,
    // Refresh the viewer's role on tab focus so a just-promoted user's UI
    // (e.g. the API-keys page gate) reflects their new role without a reload.
    refetchOnWindowFocus: true,
  });
