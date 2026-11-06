export type ArchiveMediaFile = { id: string; fileName: string; fileType: string; size: number };
export type ArchiveMediaAccess = { playUrl: string; downloadUrl: string; expiresAt: string };

/** The server returns resource locators only. The browser keeps the separate, scoped
 * HttpOnly grant; neither the bearer token nor a media credential enters a URL. */
export async function authorizeArchiveMedia(fileId: string, token: string, audience: "member" | "staff", signal?: AbortSignal): Promise<ArchiveMediaAccess> {
  const response = await fetch("/api/media/access", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, audience })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 401 ? "Please sign in again to open this archive." : data.errors?.[0] || "This archive file is no longer available.");
  const prefix = `/api/media/files/${encodeURIComponent(fileId)}/`;
  if (data.playUrl !== prefix + "play" || data.downloadUrl !== prefix + "download") throw new Error("The archive returned an invalid media location.");
  return data as ArchiveMediaAccess;
}

export function downloadArchiveMedia(url: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = url; link.download = fileName; link.rel = "noreferrer";
  document.body.appendChild(link); link.click(); link.remove();
}
