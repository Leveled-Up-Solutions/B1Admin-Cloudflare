-- Synthetic calendars and gatherings, not real church schedules.
INSERT OR IGNORE INTO calendars(id,churchId,name,description,color,timeZone,groupId,updatedAt) VALUES
('calendar-demo','church-demo','Demo church calendar','Synthetic development schedule.','#2563eb','America/New_York',NULL,'2026-01-01T00:00:00.000Z'),
('calendar-welcome','church-demo','Welcome team','Synthetic group calendar.','#15803d','America/New_York','group-welcome','2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO calendar_events(id,churchId,calendarId,groupId,title,description,start,end,allDay,location,timeZone,updatedAt) VALUES
('event-demo','church-demo','calendar-demo',NULL,'Demo community gathering','Synthetic event for development.','2027-01-10T15:00:00.000Z','2027-01-10T16:00:00.000Z',0,'Demo community hall','America/New_York','2026-01-01T00:00:00.000Z'),
('event-welcome','church-demo','calendar-welcome','group-welcome','Welcome team planning','Synthetic team planning session.','2027-01-09T16:00:00.000Z','2027-01-09T17:00:00.000Z',0,'Demo meeting room','America/New_York','2026-01-01T00:00:00.000Z'),
('event-day','church-demo','calendar-demo',NULL,'Demo service day','All-day synthetic event. End is exclusive.','2027-01-16','2027-01-17',1,'Demo community hall','America/New_York','2026-01-01T00:00:00.000Z');
