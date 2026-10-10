import type { CreateOnisallIntakeDraft, ObserveOnisallInput, OnisallIntakeDraft,
  OnisallInputObservation, OnisallObservationPage } from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/onisall/intakes`;
export const onisallIntakesApi = {
  create: (companyId: string, input: CreateOnisallIntakeDraft) =>
    api.post<{ draft: OnisallIntakeDraft; replayed: boolean }>(base(companyId), input),
  get: (companyId: string, id: string) => api.get<OnisallIntakeDraft>(`${base(companyId)}/${encodeURIComponent(id)}`),
  observe: (companyId: string, id: string, input: ObserveOnisallInput) =>
    api.post<{ observation: OnisallInputObservation; replayed: boolean }>(`${base(companyId)}/${encodeURIComponent(id)}/observations`, input),
  observations: (companyId: string, id: string, offset = 0) =>
    api.get<OnisallObservationPage>(`${base(companyId)}/${encodeURIComponent(id)}/observations?offset=${offset}`),
  contentPath: (companyId: string, id: string) => `/api${base(companyId)}/${encodeURIComponent(id)}/content`,
};
