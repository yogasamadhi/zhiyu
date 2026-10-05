export const analyticsSqliteMigration002 = `
ALTER TABLE analysis_jobs ADD COLUMN provenance TEXT;
ALTER TABLE analysis_results ADD COLUMN parameters TEXT;
ALTER TABLE analysis_results ADD COLUMN provenance TEXT;
UPDATE analysis_results SET parameters=(SELECT parameters FROM analysis_jobs WHERE id=analysis_results.job_id);

CREATE TABLE analysis_result_collections (
  result_id TEXT NOT NULL REFERENCES analysis_results(id) ON DELETE CASCADE,
  section TEXT NOT NULL CHECK(section IN ('table','series')),
  collection_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position>=0),
  series_type TEXT,
  encoding_data TEXT,
  columns_data TEXT,
  artifact_id TEXT,
  total_rows INTEGER NOT NULL CHECK(total_rows>=0),
  PRIMARY KEY(result_id,section,collection_id),
  UNIQUE(result_id,section,position)
);
CREATE TABLE analysis_result_rows (
  result_id TEXT NOT NULL,
  section TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  row_index INTEGER NOT NULL CHECK(row_index>=0),
  row_data TEXT NOT NULL,
  PRIMARY KEY(result_id,section,collection_id,row_index),
  FOREIGN KEY(result_id,section,collection_id) REFERENCES analysis_result_collections(result_id,section,collection_id) ON DELETE CASCADE
);

INSERT INTO analysis_result_collections(result_id,section,collection_id,position,columns_data,artifact_id,total_rows)
SELECT r.id,'table',json_extract(t.value,'$.id'),CAST(t.key AS INTEGER),json_extract(t.value,'$.columns'),json_extract(t.value,'$.artifactId'),json_array_length(t.value,'$.rows')
FROM analysis_results r,json_each(r.tables_data) t;
INSERT INTO analysis_result_collections(result_id,section,collection_id,position,series_type,encoding_data,total_rows)
SELECT r.id,'series',json_extract(s.value,'$.id'),CAST(s.key AS INTEGER),json_extract(s.value,'$.type'),json_extract(s.value,'$.encoding'),json_array_length(s.value,'$.data')
FROM analysis_results r,json_each(r.series_data) s;
INSERT INTO analysis_result_rows(result_id,section,collection_id,row_index,row_data)
SELECT r.id,'table',json_extract(t.value,'$.id'),CAST(v.key AS INTEGER),v.value
FROM analysis_results r,json_each(r.tables_data) t,json_each(t.value,'$.rows') v;
INSERT INTO analysis_result_rows(result_id,section,collection_id,row_index,row_data)
SELECT r.id,'series',json_extract(s.value,'$.id'),CAST(v.key AS INTEGER),v.value
FROM analysis_results r,json_each(r.series_data) s,json_each(s.value,'$.data') v;
`;
