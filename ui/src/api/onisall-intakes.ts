import type { CreateOnisallIntakeDraft, ObserveOnisallInput, OnisallIntakeDraft,
  OnisallInputObservation, OnisallObservationPage, OnisallNativeBinding, OnisallBindingContext,
  OnisallBindingContextInput, CreateOnisallBinding, OnisallPreparationStatus, OnisallNativeRevalidation,
  CreateOnisallPreparationBaseline, OnisallPreparationBaseline, OnisallPreparationBaselineStatus } from "@paperclipai/shared";
import { api } from "./client";
import type { RequestOptions } from "./client";

const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/onisall/intakes`;
export const onisallIntakesApi = {
  create: (companyId: string, input: CreateOnisallIntakeDraft) =>
    api.post<{ draft: OnisallIntakeDraft; replayed: boolean }>(base(companyId), input),
  get: (companyId: string, id: string, options?: RequestOptions) => api.get<OnisallIntakeDraft>(`${base(companyId)}/${encodeURIComponent(id)}`, options),
  preparationStatus: (companyId: string, id: string, options?: RequestOptions) =>
    api.get<OnisallPreparationStatus>(`${base(companyId)}/${encodeURIComponent(id)}/preparation-status`, { cache: "no-store", ...options }),
  nativeRevalidation: (companyId: string, id: string, options?: RequestOptions) =>
    api.get<OnisallNativeRevalidation>(`${base(companyId)}/${encodeURIComponent(id)}/native-revalidation`, { cache: "no-store", ...options }),
  createPreparationBaseline: (companyId: string, id: string, input: CreateOnisallPreparationBaseline) =>
    api.post<{ baseline: OnisallPreparationBaseline; replayed: boolean }>(`${base(companyId)}/${encodeURIComponent(id)}/preparation-baselines`, input),
  preparationBaselineStatus: (companyId: string, id: string, baselineId: string, options?: RequestOptions) =>
    api.get<OnisallPreparationBaselineStatus>(`${base(companyId)}/${encodeURIComponent(id)}/preparation-baselines/${encodeURIComponent(baselineId)}`, { cache: "no-store", ...options }),
  observe: (companyId: string, id: string, input: ObserveOnisallInput) =>
    api.post<{ observation: OnisallInputObservation; replayed: boolean }>(`${base(companyId)}/${encodeURIComponent(id)}/observations`, input),
  observations: (companyId: string, id: string, offset = 0) =>
    api.get<OnisallObservationPage>(`${base(companyId)}/${encodeURIComponent(id)}/observations?offset=${offset}`),
  bindingContext: (companyId: string, id: string, input: OnisallBindingContextInput) =>
    api.get<OnisallBindingContext>(`${base(companyId)}/${encodeURIComponent(id)}/binding-context?${new URLSearchParams(input)}`),
  binding: (companyId: string, id: string) =>
    api.get<{ binding: OnisallNativeBinding | null }>(`${base(companyId)}/${encodeURIComponent(id)}/binding`),
  bind: (companyId: string, id: string, input: CreateOnisallBinding) =>
    api.post<{ binding: OnisallNativeBinding; replayed: boolean }>(`${base(companyId)}/${encodeURIComponent(id)}/binding`, input),
  contentPath: (companyId: string, id: string) => `/api${base(companyId)}/${encodeURIComponent(id)}/content`,
};
