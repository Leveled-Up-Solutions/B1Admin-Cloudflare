import React from "react";
import { memberErrorMessage, memberRequest, memberSessionExpired } from "./memberApi";

export interface MemberPaginationData {
  limit: number; offset: number; count: number; hasMore: boolean; nextOffset: number | null; truncated: boolean;
}
export interface MemberPage<T> { items: T[]; pagination: MemberPaginationData }

export function useMemberPage<T>(path: string, token: string, query: Record<string, string> = {}, refresh = 0, onExpired?: () => void, enabled = true, limit = 20) {
  const queryString = new URLSearchParams(Object.entries(query).sort(([a], [b]) => a.localeCompare(b))).toString();
  // The context key stays in component memory; it is never logged or persisted.
  const context = JSON.stringify([token, path, queryString, refresh]);
  const [position, setPosition] = React.useState({ context, offset: 0 });
  const offset = position.context === context ? position.offset : 0;
  React.useEffect(() => {
    // Forget an old page when leaving its query, including A → B → A changes.
    setPosition(previous => previous.context === context ? previous : { context, offset: 0 });
  }, [context]);
  const [retry, setRetry] = React.useState(0);
  const key = JSON.stringify([context, offset, retry]);
  const [result, setResult] = React.useState<{ key: string; data?: MemberPage<T>; error?: string }>({ key: "" });
  const active = enabled && !!token;
  React.useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let current = true;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams(queryString);
        params.set("paged", "1"); params.set("limit", String(limit)); params.set("offset", String(offset));
        const data = await memberRequest<MemberPage<T>>(`${path}?${params}`, token, { signal: controller.signal });
        if (!Array.isArray(data.items) || !data.pagination) throw new Error("The server returned an invalid page.");
        if (current) setResult({ key, data });
      } catch (error) {
        if (!current || controller.signal.aborted) return;
        if (memberSessionExpired(error)) onExpired?.();
        setResult({ key, error: memberErrorMessage(error) });
      }
    }, 150);
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [
    active, key, path, queryString, token, offset, limit, onExpired
  ]);
  const current = active && result.key === key;
  return {
    items: current ? result.data?.items || [] : [],
    pagination: current ? result.data?.pagination : undefined,
    error: current ? result.error || "" : "",
    loading: active && !current,
    offset,
    previous: () => setPosition({ context, offset: Math.max(0, offset - limit) }),
    next: () => { if (current && result.data?.pagination.nextOffset != null) setPosition({ context, offset: result.data.pagination.nextOffset }); },
    reload: () => setRetry(value => value + 1)
  };
}

export type MemberPageState<T> = ReturnType<typeof useMemberPage<T>>;
