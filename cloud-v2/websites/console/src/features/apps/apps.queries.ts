import { queryOptions } from "@tanstack/react-query";
import { listDeveloperApps } from "./apps.api";

export const appsQuery = (enabled = true) =>
  queryOptions({
    queryKey: ["developer-apps"],
    queryFn: listDeveloperApps,
    enabled,
  });
