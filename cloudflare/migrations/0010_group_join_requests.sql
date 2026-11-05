CREATE TABLE group_join_requests (
  id TEXT PRIMARY KEY,
  churchId TEXT NOT NULL,
  groupId TEXT NOT NULL,
  personId TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '' CHECK(length(message)<=1000),
  requestDate TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','cancelled')),
  decidedBy TEXT,
  decidedDate TEXT,
  declineReason TEXT CHECK(length(declineReason)<=500),
  decisionId TEXT,
  UNIQUE(churchId,id),
  FOREIGN KEY(churchId,groupId) REFERENCES groups(churchId,id) ON DELETE CASCADE,
  FOREIGN KEY(churchId,personId) REFERENCES people(churchId,id),
  FOREIGN KEY(churchId,decidedBy) REFERENCES people(churchId,id)
);
CREATE UNIQUE INDEX group_join_requests_pending ON group_join_requests(churchId,groupId,personId) WHERE status='pending';
CREATE INDEX group_join_requests_person ON group_join_requests(churchId,personId,requestDate);
CREATE INDEX group_join_requests_review ON group_join_requests(churchId,status,groupId,requestDate);
