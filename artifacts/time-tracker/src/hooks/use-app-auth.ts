import { useQuery, useQueryClient } from "@tanstack/react-query";

export type AuthState = "loading" | "authenticated" | "unauthenticated";

export const APP_AUTH_QUERY_KEY = ["app-auth"] as const;

async function fetchAuthStatus(): Promise<boolean> {
  const res = await fetch("/api/auth/app/me", { credentials: "include" });
  return res.ok;
}

/** Returns the current auth state, always fetches fresh on mount. */
export function useAppAuth(): AuthState {
  const { data, isLoading } = useQuery<boolean>({
    queryKey: APP_AUTH_QUERY_KEY,
    queryFn: fetchAuthStatus,
    retry: false,
    staleTime: 0,         // always consider stale → re-fetches on every mount
    gcTime: 0,            // do not cache across unmounts
  });

  if (isLoading) return "loading";
  return data ? "authenticated" : "unauthenticated";
}

/** Call after login to immediately mark the user as authenticated. */
export function useSetAuthenticated() {
  const qc = useQueryClient();
  return () => qc.setQueryData<boolean>(APP_AUTH_QUERY_KEY, true);
}

/** Call after logout to immediately clear auth state. */
export function useSetUnauthenticated() {
  const qc = useQueryClient();
  return () => qc.setQueryData<boolean>(APP_AUTH_QUERY_KEY, false);
}
