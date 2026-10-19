import type { OnisallContractPreparationCatalog, OnisallContractPreparationStatus } from "@paperclipai/shared";
import { api } from "./client";
const base = (companyId: string, intakeId: string) => `/companies/${companyId}/onisall/intakes/${intakeId}/contract-preparations`;
export const onisallContractPreparationsApi = {
  list: (companyId: string, intakeId: string, offset = 0, options?: { signal?: AbortSignal }) =>
    api.get<OnisallContractPreparationCatalog>(`${base(companyId, intakeId)}${offset ? `?offset=${offset}` : ""}`, { ...options, cache: "no-store" }),
  get: (companyId: string, intakeId: string, id: string, options?: { signal?: AbortSignal }) =>
    api.get<OnisallContractPreparationStatus>(`${base(companyId, intakeId)}/${id}`, { ...options, cache: "no-store" }),
};
