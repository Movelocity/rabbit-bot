import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { ApiError, apiBlobRequest, apiRequest, type RequestOptions } from "./api.ts";

export type Request = <T>(path: string, opts?: RequestOptions) => Promise<T>;
export type RequestBlob = (path: string, opts?: RequestOptions) => Promise<Blob>;

interface ApiContextValue {
  request: Request;
  requestBlob: RequestBlob;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({
  token,
  onUnauthorized,
  children,
}: {
  token: string;
  onUnauthorized: () => void;
  children: ReactNode;
}) {
  const request = useCallback<Request>(
    async (path, opts) => {
      try {
        return await apiRequest(token, path, opts);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        throw e;
      }
    },
    [token, onUnauthorized],
  );

  const requestBlob = useCallback<RequestBlob>(
    async (path, opts) => {
      try {
        return await apiBlobRequest(token, path, opts);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        throw e;
      }
    },
    [token, onUnauthorized],
  );

  const value = useMemo(() => ({ request, requestBlob }), [request, requestBlob]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): Request {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi 必须在 ApiProvider 内使用");
  return ctx.request;
}

export function useApiBlob(): RequestBlob {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApiBlob 必须在 ApiProvider 内使用");
  return ctx.requestBlob;
}
