-- Manual My Work tasks; workflow cards and external reminders are separate future modules.
CREATE TABLE tasks (
 id TEXT PRIMARY KEY,
 churchId TEXT NOT NULL REFERENCES churches(id),
 taskNumber INTEGER NOT NULL,
 title TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('Open','Closed')),
 dateCreated TEXT NOT NULL,
 dateClosed TEXT,
 dueDate TEXT,
 createdById TEXT NOT NULL,
 assignedPersonId TEXT,
 assignedGroupId TEXT,
 associatedPersonId TEXT,
 associatedGroupId TEXT,
 UNIQUE(churchId,id),
 UNIQUE(churchId,taskNumber),
 CHECK((assignedPersonId IS NOT NULL) != (assignedGroupId IS NOT NULL)),
 CHECK(associatedPersonId IS NULL OR associatedGroupId IS NULL),
 FOREIGN KEY(churchId,createdById) REFERENCES people(churchId,id),
 FOREIGN KEY(churchId,assignedPersonId) REFERENCES people(churchId,id),
 FOREIGN KEY(churchId,assignedGroupId) REFERENCES groups(churchId,id),
 FOREIGN KEY(churchId,associatedPersonId) REFERENCES people(churchId,id),
 FOREIGN KEY(churchId,associatedGroupId) REFERENCES groups(churchId,id)
);
CREATE INDEX tasks_person ON tasks(churchId,assignedPersonId,status);
CREATE INDEX tasks_group ON tasks(churchId,assignedGroupId,status);
