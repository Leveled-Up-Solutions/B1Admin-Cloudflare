import { ApiHelper } from "@churchapps/apphelper";
import type { PlaylistInterface, SermonInterface } from "@churchapps/helpers";

export type ArchivePlaylist = PlaylistInterface & { canEdit?: boolean };
export type ArchiveSermon = SermonInterface & { canEdit?: boolean; playlistTitle?: string; speaker?: string; visibility?: "public" | "private"; publishedAt?: string | null };

function edit(contentType: string, contentId?: string): boolean {
  return (ApiHelper.getConfig("ContentApi")?.permissions || []).some(permission =>
    permission.contentType === contentType && permission.action === "Edit" &&
    (!permission.contentId || permission.contentId === contentId));
}
function globalArchiveEdit(): boolean { return edit("Content") || edit("StreamingServices"); }
export function canOpenSermonArchive(): boolean {
  return (ApiHelper.getConfig("ContentApi")?.permissions || []).some(permission =>
    ["Content", "Sermons", "Playlists"].includes(permission.contentType || "") && ["View", "Edit"].includes(permission.action || "") ||
    permission.contentType === "StreamingServices" && permission.action === "Edit");
}
export function canListArchivePlaylists(): boolean {
  return (ApiHelper.getConfig("ContentApi")?.permissions || []).some(permission =>
    ["Content", "Playlists"].includes(permission.contentType || "") && ["View", "Edit"].includes(permission.action || "") ||
    permission.contentType === "StreamingServices" && permission.action === "Edit");
}
export function canCreateArchivePlaylist(): boolean { return globalArchiveEdit() || edit("Playlists"); }
export function canCreateUnassignedSermon(): boolean { return globalArchiveEdit() || edit("Sermons"); }
export function canCreateArchiveSermon(playlistId?: string): boolean {
  return canCreateUnassignedSermon() || !!playlistId && edit("Playlists", playlistId);
}
export function canEditArchiveSermon(sermon: ArchiveSermon): boolean {
  return sermon.id ? sermon.canEdit === true : canCreateArchiveSermon(sermon.playlistId);
}
export function canEditArchivePlaylist(playlist: ArchivePlaylist): boolean {
  return playlist.id ? playlist.canEdit === true : canCreateArchivePlaylist();
}
