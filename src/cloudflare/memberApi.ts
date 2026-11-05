const memberSessionKey = "b1-member-session-v1";
let memoryToken = "";
export function storedMemberToken(): string {
  try { return sessionStorage.getItem(memberSessionKey) || memoryToken; } catch { return memoryToken; }
}
export function saveMemberToken(value: string): void {
  memoryToken = value;
  try { if (value) sessionStorage.setItem(memberSessionKey, value); else sessionStorage.removeItem(memberSessionKey); } catch { /* Same-page handoff and the current session still work. */ }
}

export async function memberRequest(path: string, token: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(path, { ...init, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers }, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(response.status === 401 ? "Your session has ended. Please sign in again." : data.errors?.[0] || data.error?.message || data.error || data.message || `Could not load this information (${response.status}).`), { status: response.status });
  return data;
}
