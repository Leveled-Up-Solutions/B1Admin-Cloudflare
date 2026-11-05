-- Preserve existing metadata while extending only the resumable archive path to 1 GiB.
CREATE TABLE content_files_large (
 id TEXT PRIMARY KEY,
 churchId TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
 contentType TEXT NOT NULL DEFAULT 'sermon' CHECK(contentType='sermon'),
 contentId TEXT NOT NULL,
 fileName TEXT NOT NULL,
 fileType TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size >= 1 AND size <= 1073741824),
 objectKey TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('pending','ready','deleting')),
 dateModified TEXT NOT NULL,
 UNIQUE(churchId,id),
 FOREIGN KEY(churchId,contentId) REFERENCES content_sermons(churchId,id)
);
INSERT INTO content_files_large SELECT * FROM content_files;
DROP TABLE content_files;
ALTER TABLE content_files_large RENAME TO content_files;
CREATE INDEX content_files_church ON content_files(churchId,contentType,contentId,state);
CREATE INDEX content_files_cleanup ON content_files(state,dateModified);
CREATE TABLE media_uploads (
 id TEXT PRIMARY KEY,
 churchId TEXT NOT NULL REFERENCES churches(id),
 userId TEXT NOT NULL REFERENCES users(id),
 fileId TEXT REFERENCES content_files(id) ON DELETE SET NULL,
 contentId TEXT NOT NULL,
 fileName TEXT NOT NULL,
 fileType TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 1073741824),
 partSize INTEGER NOT NULL CHECK(partSize=8388608),
 totalParts INTEGER NOT NULL CHECK(totalParts BETWEEN 1 AND 128),
 objectKey TEXT NOT NULL UNIQUE,
 uploadId TEXT,
 idempotencyKey TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('creating','uploading','completing','complete','aborting','aborted')),
 createdAt TEXT NOT NULL,
 updatedAt TEXT NOT NULL,
 expiresAt TEXT NOT NULL,
 finishedAt TEXT,
 UNIQUE(churchId,userId,idempotencyKey),
 FOREIGN KEY(churchId,contentId) REFERENCES content_sermons(churchId,id) ON DELETE CASCADE
);
CREATE INDEX media_uploads_cleanup ON media_uploads(state,expiresAt);
CREATE INDEX media_uploads_owner ON media_uploads(churchId,userId,contentId,state);
CREATE TABLE media_upload_parts (
 sessionId TEXT NOT NULL REFERENCES media_uploads(id) ON DELETE CASCADE,
 partNumber INTEGER NOT NULL CHECK(partNumber BETWEEN 1 AND 128),
 size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
 providerPartNumber INTEGER,
 etag TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending','ready')),
 PRIMARY KEY(sessionId,partNumber),
 CHECK((state='pending' AND providerPartNumber IS NULL AND etag IS NULL) OR (state='ready' AND providerPartNumber BETWEEN 1 AND 1024 AND etag IS NOT NULL))
);
CREATE TRIGGER media_upload_file_scope BEFORE INSERT ON media_uploads WHEN NOT EXISTS(SELECT 1 FROM content_files WHERE id=NEW.fileId AND churchId=NEW.churchId AND contentId=NEW.contentId AND state='pending') BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: media_upload_file_scope'); END;
CREATE TRIGGER media_upload_active_limit BEFORE INSERT ON media_uploads WHEN (SELECT count(*) FROM media_uploads WHERE churchId=NEW.churchId AND userId=NEW.userId AND state IN ('creating','uploading','completing'))>=3 OR (SELECT count(*) FROM media_uploads WHERE churchId=NEW.churchId AND state IN ('creating','uploading','completing'))>=20 BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: media_upload_active_limit'); END;
CREATE TRIGGER media_part_session_guard BEFORE INSERT ON media_upload_parts WHEN NOT EXISTS(SELECT 1 FROM media_uploads WHERE id=NEW.sessionId AND state='uploading' AND NEW.partNumber<=totalParts AND NEW.size=CASE WHEN NEW.partNumber=totalParts THEN size-(totalParts-1)*partSize ELSE partSize END) BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: media_part_session_guard'); END;
