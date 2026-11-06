-- Synthetic standalone task. No messaging, reminders or workflow execution.
INSERT OR IGNORE INTO tasks(id,churchId,taskNumber,title,status,dateCreated,createdById,assignedPersonId) VALUES('task-demo','church-demo',1,'Prepare the service welcome table','Open','2026-11-01T10:00:00.000Z','person-admin','person-admin');
