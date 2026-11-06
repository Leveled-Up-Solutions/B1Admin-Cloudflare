-- A failed assertion aborts its enclosing D1 batch, including earlier mutations/audits.
-- Guard rows are inserted and removed within the same batch and never committed.
CREATE TABLE write_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CONSTRAINT authorized_write_snapshot CHECK(valid=1));
