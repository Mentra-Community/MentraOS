import { queryOptions } from "@tanstack/react-query";
import { listApiTokens } from "./tokens.api";

export const apiTokensQuery = (enabled = true) =>
  queryOptions({
    queryKey: ["api-tokens"],
    queryFn: listApiTokens,
    enabled,
  });
