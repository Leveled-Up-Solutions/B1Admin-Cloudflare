-- D1 calendar extension with ChurchApps event field names.
CREATE TABLE calendars (
 id TEXT PRIMARY KEY,
 churchId TEXT NOT NULL REFERENCES churches(id),
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 color TEXT NOT NULL DEFAULT '#2563eb',
 timeZone TEXT NOT NULL DEFAULT 'UTC',
 groupId TEXT,
 updatedAt TEXT NOT NULL,
 UNIQUE(churchId,id),
 FOREIGN KEY(churchId,groupId) REFERENCES groups(churchId,id)
);
CREATE INDEX calendars_church ON calendars(churchId,name);
CREATE TABLE calendar_events (
 id TEXT PRIMARY KEY,
 churchId TEXT NOT NULL REFERENCES churches(id),
 calendarId TEXT NOT NULL,
 groupId TEXT,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 start TEXT NOT NULL,
 end TEXT NOT NULL,
 allDay INTEGER NOT NULL DEFAULT 0 CHECK(allDay IN (0,1)),
 location TEXT NOT NULL DEFAULT '',
 timeZone TEXT NOT NULL,
 updatedAt TEXT NOT NULL,
 UNIQUE(churchId,id),
 FOREIGN KEY(churchId,calendarId) REFERENCES calendars(churchId,id),
 FOREIGN KEY(churchId,groupId) REFERENCES groups(churchId,id),
 CHECK(end>start)
);
CREATE INDEX calendar_events_window ON calendar_events(churchId,start,end);
CREATE INDEX calendar_events_calendar ON calendar_events(churchId,calendarId,start);
CREATE INDEX calendar_events_group ON calendar_events(churchId,groupId,start);
-- Validate relationships inside SQLite as well as before writes, including racing requests.
CREATE TRIGGER calendar_group_change_guard BEFORE UPDATE OF groupId ON calendars WHEN NEW.groupId IS NOT OLD.groupId AND EXISTS(SELECT 1 FROM calendar_events WHERE churchId=OLD.churchId AND calendarId=OLD.id) BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: calendar_group_has_events'); END;
CREATE TRIGGER calendar_event_group_insert BEFORE INSERT ON calendar_events WHEN EXISTS(SELECT 1 FROM calendars WHERE churchId=NEW.churchId AND id=NEW.calendarId AND groupId IS NOT NULL AND groupId IS NOT NEW.groupId) BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: event_calendar_group'); END;
CREATE TRIGGER calendar_event_group_update BEFORE UPDATE OF calendarId,groupId ON calendar_events WHEN EXISTS(SELECT 1 FROM calendars WHERE churchId=NEW.churchId AND id=NEW.calendarId AND groupId IS NOT NULL AND groupId IS NOT NEW.groupId) BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: event_calendar_group'); END;
