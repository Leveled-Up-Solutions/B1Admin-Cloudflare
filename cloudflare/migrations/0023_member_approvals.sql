-- Review records own private proposed changes. Generic My Work tasks contain only metadata.
ALTER TABLE tasks ADD COLUMN taskType TEXT CHECK(taskType IS NULL OR taskType='directoryUpdate');
CREATE TABLE member_change_requests (
 id TEXT PRIMARY KEY,
 churchId TEXT NOT NULL REFERENCES churches(id),
 taskId TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('profile','family-add','family-edit')),
 requesterUserId TEXT NOT NULL REFERENCES users(id),
 requesterPersonId TEXT NOT NULL,
 requesterHouseholdId TEXT,
 targetPersonId TEXT,
 targetKey TEXT NOT NULL,
 reviewGroupId TEXT,
 changes TEXT NOT NULL CHECK(json_valid(changes)),
 snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','cancelled')),
 createdAt TEXT NOT NULL,
 decidedAt TEXT,
 decidedBy TEXT,
 reason TEXT,
 resultPersonId TEXT,
 UNIQUE(churchId,id),
 FOREIGN KEY(churchId,taskId) REFERENCES tasks(churchId,id),
 FOREIGN KEY(churchId,requesterPersonId) REFERENCES people(churchId,id),
 FOREIGN KEY(churchId,targetPersonId) REFERENCES people(churchId,id),
 FOREIGN KEY(churchId,resultPersonId) REFERENCES people(churchId,id)
);
CREATE UNIQUE INDEX member_change_pending ON member_change_requests(churchId,requesterUserId,kind,targetKey) WHERE status='pending';
CREATE INDEX member_change_queue ON member_change_requests(churchId,status,createdAt);
CREATE INDEX member_change_own ON member_change_requests(churchId,requesterUserId,createdAt);
