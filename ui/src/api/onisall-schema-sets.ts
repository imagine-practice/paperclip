import type { OnisallFrozenSchemaSetStatus } from "@paperclipai/shared";
import { api } from "./client";

export const onisallSchemaSetsApi = {
  get: (companyId: string, id: string) => api.get<OnisallFrozenSchemaSetStatus>(
    `/companies/${encodeURIComponent(companyId)}/onisall/schema-sets/${encodeURIComponent(id)}`),
};
