-- Only the selected planType/group association contract is ported.
CREATE TABLE associated_groups (
 id TEXT PRIMARY KEY,
 churchId TEXT NOT NULL REFERENCES churches(id),
 contentType TEXT NOT NULL CHECK(contentType='planType'),
 contentId TEXT NOT NULL,
 groupId TEXT NOT NULL,
 settings TEXT NOT NULL DEFAULT 'both' CHECK(settings IN ('past','future','both')),
 UNIQUE(churchId,id),
 UNIQUE(churchId,contentType,contentId,groupId),
 FOREIGN KEY(churchId,contentId) REFERENCES doing_plan_types(churchId,id) ON DELETE CASCADE,
 FOREIGN KEY(churchId,groupId) REFERENCES groups(churchId,id) ON DELETE CASCADE
);
CREATE INDEX associated_groups_content ON associated_groups(churchId,contentType,contentId);
CREATE INDEX associated_groups_group ON associated_groups(churchId,groupId,contentType);
