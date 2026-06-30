import { queryOptions } from "@tanstack/react-query";
import { getConsoleSession } from "./session.api";

export const sessionQuery = () =>
  queryOptions({
    queryKey: ["console-session"],
    queryFn: getConsoleSession,
    retry: false,
  });
