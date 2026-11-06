ALTER TABLE sessions ADD COLUMN mediaAccessVersion INTEGER NOT NULL DEFAULT 0 CHECK(mediaAccessVersion>=0);
CREATE TABLE media_access (
  tokenHash TEXT PRIMARY KEY CHECK(length(tokenHash)=64),
  sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  churchId TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  fileId TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience IN ('member','staff')),
  sessionVersion INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  UNIQUE(sessionId,fileId),
  FOREIGN KEY(churchId,fileId) REFERENCES content_files(churchId,id) ON DELETE CASCADE
);
CREATE INDEX media_access_expiry ON media_access(expiresAt);
