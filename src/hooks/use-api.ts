/**
 * useApi — thin wrapper around ApiContext.
 *
 * Returns the single shared ApiClient instance created by ApiProvider.
 * All 28+ existing call-sites continue to work without modification.
 *
 * The optional `config` parameter is kept for backwards compatibility but
 * is no longer used — the ApiProvider determines the client configuration.
 */
import { useApiContext } from "@/contexts/ApiContext";
import type { ApiConfig } from "@/types/api";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const useApi = (_config?: Partial<ApiConfig>) => {
  return useApiContext();
};