-- Synthetic fixtures only. Local seed script refuses remote operation.
INSERT OR IGNORE INTO churches(id,name,subDomain) VALUES ('church-demo','Cloudflare Demo Church','demo'),('church-other','Tenant Isolation Church','other');
INSERT OR IGNORE INTO households(id,churchId,name) VALUES('household-demo','church-demo','Demo Household');
INSERT OR IGNORE INTO people(id,churchId,firstName,lastName,email,contactInfo,membershipStatus,householdId,dateAdded) VALUES
('person-admin','church-demo','Demo','Administrator','admin@example.test','{"email":"admin@example.test"}','Member','household-demo','2026-01-01T00:00:00.000Z'),
('person-alex','church-demo','Alex','Example','alex@example.test','{"email":"alex@example.test"}','Member',NULL,'2026-01-01T00:00:00.000Z'),
('person-jordan','church-demo','Jordan','Sample','viewer@example.test','{"email":"viewer@example.test"}','Visitor',NULL,'2026-01-01T00:00:00.000Z'),
('person-other','church-other','Other','Tenant','other@example.test','{}','Member',NULL,'2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO users(id,email,firstName,lastName,passwordHash) VALUES ('user-admin','admin@example.test','Demo','Administrator','pbkdf2$100000$ZGV2ZWxvcG1lbnQtc3ludGhldGljLWZpeHR1cmU$3mnmc_QZghI8LCQhK1u_Kokuh7uS8e0a0UjUaTPHX-o'),('user-viewer','viewer@example.test','Jordan','Sample','pbkdf2$100000$ZGV2ZWxvcG1lbnQtc3ludGhldGljLWZpeHR1cmU$3mnmc_QZghI8LCQhK1u_Kokuh7uS8e0a0UjUaTPHX-o'),('user-other','other@example.test','Other','Tenant','pbkdf2$100000$ZGV2ZWxvcG1lbnQtc3ludGhldGljLWZpeHR1cmU$3mnmc_QZghI8LCQhK1u_Kokuh7uS8e0a0UjUaTPHX-o');
INSERT OR IGNORE INTO user_churches VALUES('user-admin','church-demo','person-admin','admin'),('user-viewer','church-demo','person-jordan','viewer'),('user-other','church-other','person-other','admin');
INSERT OR IGNORE INTO groups(id,churchId,name,categoryName,tags,trackAttendance) VALUES('group-welcome','church-demo','Welcome Team','Ministry','standard',1);
INSERT OR IGNORE INTO group_members(id,churchId,groupId,personId,leader) VALUES('member-admin','church-demo','group-welcome','person-admin',1);

INSERT OR IGNORE INTO users(id,email,firstName,lastName,passwordHash) SELECT 'user-member','member@example.test','Alex','Example',passwordHash FROM users WHERE id='user-admin';
INSERT OR IGNORE INTO user_churches VALUES('user-member','church-demo','person-alex','member');
INSERT OR IGNORE INTO group_members(id,churchId,groupId,personId,leader) VALUES('member-alex','church-demo','group-welcome','person-alex',0);
UPDATE people SET directoryVisible=1,shareEmail=1 WHERE id='person-alex';
UPDATE people SET directoryVisible=1,shareEmail=0 WHERE id='person-admin';

UPDATE groups SET joinPolicy='open' WHERE id='group-welcome';

-- Separate two-church member fixture; the original member account remains single-church.
INSERT OR IGNORE INTO households(id,churchId,name) VALUES('household-multi-demo','church-demo','Demo Family'),('household-multi-other','church-other','Other Family');
INSERT OR IGNORE INTO people(id,churchId,firstName,lastName,householdId,householdRole,dateAdded) VALUES
('person-multi-demo','church-demo','Morgan','Demo','household-multi-demo','Head','2026-01-01T00:00:00.000Z'),
('person-family-demo','church-demo','Casey','Demo','household-multi-demo','Child','2026-01-01T00:00:00.000Z'),
('person-multi-other','church-other','Morgan','Other','household-multi-other','Head','2026-01-01T00:00:00.000Z'),
('person-family-other','church-other','Riley','Other','household-multi-other','Child','2026-01-01T00:00:00.000Z');
INSERT OR IGNORE INTO users(id,email,firstName,lastName,passwordHash) SELECT 'user-multi','multi-member@example.test','Morgan','Example',passwordHash FROM users WHERE id='user-admin';
INSERT OR IGNORE INTO user_churches VALUES('user-multi','church-demo','person-multi-demo','member'),('user-multi','church-other','person-multi-other','member');
