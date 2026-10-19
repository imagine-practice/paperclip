import type { OnisallFrozenSchemaSetStatus } from "@paperclipai/shared";
import { api } from "./client";
import type { RequestOptions } from "./client";

export const onisallSchemaSetsApi = {
  get: (companyId: string, id: string, options?: RequestOptions) => api.get<OnisallFrozenSchemaSetStatus>(
    `/companies/${encodeURIComponent(companyId)}/onisall/schema-sets/${encodeURIComponent(id)}`, { cache: "no-store", ...options }),
};
