-- Sermon archiving and its R2 file metadata.
CREATE TABLE content_playlists (
  id TEXT PRIMARY KEY,
  churchId TEXT NOT NULL REFERENCES churches(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  publishDate TEXT NOT NULL,
  thumbnail TEXT NOT NULL DEFAULT '',
  updatedAt TEXT NOT NULL,
  UNIQUE(churchId,id)
);
CREATE TABLE content_sermons (
  id TEXT PRIMARY KEY,
  churchId TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  speaker TEXT NOT NULL DEFAULT '',
  publishDate TEXT NOT NULL,
  videoUrl TEXT NOT NULL DEFAULT '',
  audioUrl TEXT NOT NULL DEFAULT '',
  thumbnail TEXT NOT NULL DEFAULT '',
  playlistId TEXT,
  videoType TEXT NOT NULL DEFAULT '',
  videoData TEXT NOT NULL DEFAULT '',
  duration REAL NOT NULL DEFAULT 0 CHECK(duration>=0),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
  publishedAt TEXT,
  updatedAt TEXT NOT NULL,
  UNIQUE(churchId,id),
  FOREIGN KEY(churchId,playlistId) REFERENCES content_playlists(churchId,id)
);
CREATE INDEX content_sermons_public ON content_sermons(churchId,visibility,publishDate);
CREATE TABLE content_files (
  id TEXT PRIMARY KEY,
  churchId TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  contentType TEXT NOT NULL DEFAULT 'sermon' CHECK(contentType='sermon'),
  contentId TEXT NOT NULL,
  fileName TEXT NOT NULL,
  fileType TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 1 AND size <= 26214400),
  objectKey TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','ready','deleting')),
  dateModified TEXT NOT NULL,
  UNIQUE(churchId,id),
  FOREIGN KEY(churchId,contentId) REFERENCES content_sermons(churchId,id)
);
CREATE INDEX content_files_church ON content_files(churchId,contentType,contentId,state);
CREATE INDEX content_files_cleanup ON content_files(state,dateModified);
