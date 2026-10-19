import type { OnisallFrozenRuleSetStatus, OnisallRuleSetCatalog } from "@paperclipai/shared";
import { api } from "./client";

export const onisallRuleSetsApi = {
  list: (companyId: string, offset = 0, options?: { signal?: AbortSignal }) =>
    api.get<OnisallRuleSetCatalog>(`/companies/${companyId}/onisall/rule-sets${offset ? `?offset=${offset}` : ""}`, { ...options, cache: "no-store" }),
  get: (companyId: string, id: string, options?: { signal?: AbortSignal }) =>
    api.get<OnisallFrozenRuleSetStatus>(`/companies/${companyId}/onisall/rule-sets/${id}`, { ...options, cache: "no-store" }),
};
