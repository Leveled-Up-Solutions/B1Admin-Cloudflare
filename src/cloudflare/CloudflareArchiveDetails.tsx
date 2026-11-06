import { Alert, Stack, Typography } from "@mui/material";
import { FormCard } from "../components/ui";
import { CloudflareSermonFiles } from "./CloudflareSermonFiles";
import type { ArchivePlaylist, ArchiveSermon } from "./sermonPermissions";

export function CloudflareSermonDetails({ sermon, onClose }: { sermon: ArchiveSermon; onClose: () => void }) {
  return <FormCard icon="video_library" title={sermon.title || "Sermon"} onCancel={onClose} data-testid="sermon-readonly-details">
    <Stack spacing={2}>
      <Alert severity="info">You can view this sermon and its archive files.</Alert>
      {sermon.playlistTitle && <Typography>Playlist: {sermon.playlistTitle}</Typography>}
      {sermon.speaker && <Typography>Speaker: {sermon.speaker}</Typography>}
      <Typography sx={{ whiteSpace: "pre-wrap" }}>{sermon.description || "No description."}</Typography>
      <Typography>Publication: {sermon.publishedAt ? "Published" : "Unpublished"}</Typography>
      {sermon.id && <CloudflareSermonFiles sermonId={sermon.id} canEdit={false} />}
    </Stack>
  </FormCard>;
}

export function CloudflarePlaylistDetails({ playlist, onClose }: { playlist: ArchivePlaylist; onClose: () => void }) {
  return <FormCard icon="playlist_play" title={playlist.title || "Playlist"} onCancel={onClose} data-testid="playlist-readonly-details">
    <Typography sx={{ whiteSpace: "pre-wrap" }}>{playlist.description || "No description."}</Typography>
  </FormCard>;
}
