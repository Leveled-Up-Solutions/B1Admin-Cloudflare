-- Church-local calendar operations need an explicit IANA zone. Existing installations
-- retain UTC until a settings editor deliberately selects their church's zone.
ALTER TABLE churches ADD COLUMN timeZone TEXT NOT NULL DEFAULT 'UTC';
