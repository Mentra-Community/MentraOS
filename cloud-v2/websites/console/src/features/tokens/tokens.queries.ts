import { queryOptions } from "@tanstack/react-query";
import { listApiTokens } from "./tokens.api";

export const apiTokensQuery = () =>
  queryOptions({
    queryKey: ["api-tokens"],
    queryFn: listApiTokens,
  });
