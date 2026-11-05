-- RRULE/exceptionDates retain the upstream recurrence contract. Overrides are atomic with exclusions.
ALTER TABLE calendar_events ADD COLUMN recurrenceRule TEXT;
ALTER TABLE calendar_events ADD COLUMN recurrenceParentId TEXT;
ALTER TABLE calendar_events ADD COLUMN recurrenceOriginalDate TEXT;
CREATE UNIQUE INDEX calendar_event_override ON calendar_events(churchId,recurrenceParentId,recurrenceOriginalDate) WHERE recurrenceParentId IS NOT NULL;
CREATE INDEX calendar_event_parent ON calendar_events(churchId,recurrenceParentId);
CREATE TABLE calendar_event_exceptions (
 id TEXT PRIMARY KEY,
 churchId TEXT NOT NULL,
 eventId TEXT NOT NULL,
 exceptionDate TEXT NOT NULL,
 createdAt TEXT NOT NULL,
 UNIQUE(churchId,eventId,exceptionDate),
 FOREIGN KEY(churchId,eventId) REFERENCES calendar_events(churchId,id) ON DELETE CASCADE
);
CREATE TRIGGER calendar_override_insert BEFORE INSERT ON calendar_events WHEN NEW.recurrenceParentId IS NOT NULL AND (NEW.recurrenceRule IS NOT NULL OR NEW.recurrenceOriginalDate IS NULL OR NOT EXISTS(SELECT 1 FROM calendar_events WHERE churchId=NEW.churchId AND id=NEW.recurrenceParentId AND recurrenceRule IS NOT NULL AND recurrenceParentId IS NULL AND calendarId=NEW.calendarId AND groupId IS NEW.groupId)) BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: invalid_calendar_override'); END;
CREATE TRIGGER calendar_override_update BEFORE UPDATE ON calendar_events WHEN NEW.recurrenceParentId IS NOT NULL AND (NEW.recurrenceRule IS NOT NULL OR NEW.recurrenceOriginalDate IS NULL OR NOT EXISTS(SELECT 1 FROM calendar_events WHERE churchId=NEW.churchId AND id=NEW.recurrenceParentId AND recurrenceRule IS NOT NULL AND recurrenceParentId IS NULL AND calendarId=NEW.calendarId AND groupId IS NEW.groupId)) BEGIN SELECT RAISE(ABORT,'CHECK constraint failed: invalid_calendar_override'); END;
CREATE TRIGGER calendar_series_delete AFTER DELETE ON calendar_events BEGIN DELETE FROM calendar_events WHERE churchId=OLD.churchId AND recurrenceParentId=OLD.id; END;
