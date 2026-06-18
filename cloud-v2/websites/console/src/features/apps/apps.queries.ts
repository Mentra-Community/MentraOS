import { queryOptions } from "@tanstack/react-query";
import { listDeveloperApps } from "./apps.api";

export const appsQuery = () =>
  queryOptions({
    queryKey: ["developer-apps"],
    queryFn: listDeveloperApps,
  });
