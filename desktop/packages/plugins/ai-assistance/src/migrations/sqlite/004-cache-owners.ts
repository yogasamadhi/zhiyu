/** Append ownership without changing the checksum of the existing cache migration. */
export const validatedCacheOwnersMigration004 = `
ALTER TABLE ai_validated_cache ADD COLUMN owner_scope_hash TEXT CHECK (length(owner_scope_hash)=64);
UPDATE ai_validated_cache SET owner_scope_hash=scope_hash;
CREATE INDEX ai_validated_cache_owner ON ai_validated_cache(owner_scope_hash);
`;
