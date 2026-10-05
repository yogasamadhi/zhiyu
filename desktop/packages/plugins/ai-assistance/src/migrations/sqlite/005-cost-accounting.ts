export const costAccountingMigration005 = `
ALTER TABLE ai_turns ADD COLUMN cost_budget TEXT;
ALTER TABLE ai_turns ADD COLUMN accounting TEXT;
`;
