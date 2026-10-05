export const datasetsSqliteMigration004 = `
CREATE TABLE dataset_cleaning_recipes (
 id TEXT PRIMARY KEY,
 dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 current_version_id TEXT NOT NULL REFERENCES dataset_cleaning_recipe_versions(id) DEFERRABLE INITIALLY DEFERRED,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE dataset_cleaning_recipe_versions (
 id TEXT PRIMARY KEY,
 recipe_id TEXT NOT NULL REFERENCES dataset_cleaning_recipes(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision > 0),
 name TEXT NOT NULL,
 steps TEXT NOT NULL,
 expected_fields TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(recipe_id,revision)
);
CREATE INDEX datasets_cleaning_recipes_idx ON dataset_cleaning_recipes(dataset_id,updated_at DESC,id DESC);
CREATE TABLE dataset_cleaning_sessions (
 id TEXT PRIMARY KEY,
 dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
 input_snapshot_id TEXT NOT NULL REFERENCES dataset_snapshots(id),
 recipe_version_id TEXT NOT NULL REFERENCES dataset_cleaning_recipe_versions(id),
 output_snapshot_ids TEXT NOT NULL,
 selected_step INTEGER NOT NULL CHECK(selected_step >= 0),
 revision INTEGER NOT NULL CHECK(revision > 0),
 report_artifact_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX datasets_cleaning_sessions_idx ON dataset_cleaning_sessions(dataset_id,created_at DESC,id DESC);
`;
