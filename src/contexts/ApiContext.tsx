/**
 * ApiContext — single shared ApiClient instance for the whole React tree.
 *
 * Previously, every component called useApi() which created its own ApiClient
 * and ran its own health-check effect. With 28+ consumers on a single page this
 * caused 28 parallel useState/useEffect registrations and potentially multiple
 * connection tests.
 *
 * Now the client is created once here and shared via context. The useApi() hook
 * in hooks/use-api.ts is a thin wrapper that calls useContext(ApiContext), so
 * all 28 existing call-sites continue to work without modification.
 */
import {
  createContext,
  useContext,
  useMemo,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { ApiClient, createApiClient } from "@/utils/api";
import { API_CONFIG } from "@/config/api";

export interface ApiContextValue {
  api: ApiClient | null;
  isConfigured: boolean;
  isConnected: boolean | null;
}

export const ApiContext = createContext<ApiContextValue>({
  api: null,
  isConfigured: false,
  isConnected: null,
});

// Shared health-check promise so that even if ApiProvider is somehow mounted
// multiple times, only one network request is issued.
let _healthPromise: Promise<boolean> | null = null;
let _healthBaseUrl: string | null = null;

function getSharedHealthCheck(client: ApiClient, baseUrl: string): Promise<boolean> {
  if (_healthPromise && _healthBaseUrl === baseUrl) return _healthPromise;
  _healthBaseUrl = baseUrl;
  _healthPromise = client
    .testConnection(1)
    .then((r) => r.success)
    .catch(() => false);
  // Allow a re-check after 30 s (backend restart, etc.)
  _healthPromise.finally(() => {
    setTimeout(() => {
      _healthPromise = null;
    }, 30_000);
  });
  return _healthPromise;
}

export function ApiProvider({ children }: { children: ReactNode }) {
  // The client is stable for the lifetime of the provider.
  const client = useMemo(() => createApiClient(API_CONFIG), []);
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSharedHealthCheck(client, API_CONFIG.baseUrl).then((ok) => {
      if (!cancelled) setIsConnected(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const value = useMemo<ApiContextValue>(
    () => ({ api: client, isConfigured: true, isConnected }),
    [client, isConnected],
  );

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export const useApiContext = () => useContext(ApiContext);
