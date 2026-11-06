-- Exact ContentApi scopes are fork semantics. Deleted resource IDs cannot retain reusable grants.
CREATE TRIGGER revoke_deleted_calendar_scope AFTER DELETE ON calendars BEGIN DELETE FROM role_permissions WHERE churchId=OLD.churchId AND apiName='ContentApi' AND contentType='Calendars' AND contentId=OLD.id; END;
CREATE TRIGGER revoke_deleted_sermon_scope AFTER DELETE ON content_sermons BEGIN DELETE FROM role_permissions WHERE churchId=OLD.churchId AND apiName='ContentApi' AND contentType='Sermons' AND contentId=OLD.id; END;
CREATE TRIGGER revoke_deleted_playlist_scope AFTER DELETE ON content_playlists BEGIN DELETE FROM role_permissions WHERE churchId=OLD.churchId AND apiName='ContentApi' AND contentType='Playlists' AND contentId=OLD.id; END;
