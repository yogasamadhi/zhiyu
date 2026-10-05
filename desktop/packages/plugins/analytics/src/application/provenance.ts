import type {
  AnalysisProvenance,
  AnalysisRecipe,
  AnalysisResult,
  CreateAnalysisJobInput,
  DatasetSnapshotReference,
} from '../contracts/index.js';
import { AnalysisResultQueryError } from '../contracts/index.js';

export const questionMethods = {
  'group-comparison': 'group.aggregate',
  'time-trend': 'time.trend',
  distribution: 'stats.descriptive',
  outliers: 'stats.outliers',
} as const;
export function captureAnalysisProvenance(
  snapshot: DatasetSnapshotReference,
  input: CreateAnalysisJobInput,
  recipe: AnalysisRecipe | null,
  parent: AnalysisResult | null,
): AnalysisProvenance {
  const fingerprint = snapshot.fingerprint ?? null;
  if (fingerprint !== null && !/^[a-f0-9]{64}$/.test(fingerprint))
    throw new AnalysisResultQueryError('METHOD_INCOMPATIBLE', 'Input fingerprint is invalid');
  const settings = snapshot.projectionSettings;
  const cleaned = settings?.kind === 'cleaning';
  if (
    cleaned &&
    (!uuid(settings.rootSnapshotId) ||
      !uuid(settings.recipeVersionId) ||
      !Number.isInteger(settings.step) ||
      Number(settings.step) < 1 ||
      Number(settings.step) > 20)
  )
    throw new AnalysisResultQueryError(
      'METHOD_INCOMPATIBLE',
      'Cleaning Snapshot provenance is invalid',
    );
  if (
    recipe &&
    (recipe.datasetId !== input.datasetId ||
      recipe.methodId !== input.methodId ||
      recipe.methodVersion !== input.methodVersion)
  )
    throw new AnalysisResultQueryError(
      'METHOD_INCOMPATIBLE',
      'Analysis Recipe is incompatible with this input',
    );
  if (
    input.questionId &&
    (!Object.hasOwn(questionMethods, input.questionId) ||
      questionMethods[input.questionId] !== input.methodId)
  )
    throw new AnalysisResultQueryError(
      'METHOD_INCOMPATIBLE',
      'Question does not match the selected analysis method',
    );
  if (
    parent &&
    (parent.datasetId !== input.datasetId ||
      parent.snapshotId !== input.snapshotId ||
      parent.methodId !== input.methodId ||
      parent.methodVersion !== input.methodVersion)
  )
    throw new AnalysisResultQueryError(
      'METHOD_INCOMPATIBLE',
      'A branch must preserve its parent input and method',
    );
  return {
    version: 1,
    inputFingerprint: fingerprint,
    sourceSnapshotId: cleaned ? String(settings.rootSnapshotId) : snapshot.id,
    cleaningRecipeVersionId: cleaned ? String(settings.recipeVersionId) : null,
    cleaningStep: cleaned ? Number(settings.step) : null,
    analysisRecipeId: recipe?.id ?? null,
    analysisRecipeRevision: recipe?.revision ?? null,
    parentResultId: parent?.id ?? null,
    questionId: input.questionId ?? parent?.provenance?.questionId ?? null,
  };
}

export function compareAnalysisResults(left: AnalysisResult, right: AnalysisResult) {
  if (
    left.datasetId !== right.datasetId ||
    left.methodId !== right.methodId ||
    left.methodVersion !== right.methodVersion ||
    (left.snapshotId !== right.snapshotId &&
      (!left.provenance?.inputFingerprint ||
        left.provenance.inputFingerprint !== right.provenance?.inputFingerprint))
  )
    incompatible('Select results from the same Dataset, input and method version');
  if (canonical(left.sampling) !== canonical(right.sampling))
    incompatible('Sampling strategies or sample sizes differ');
  const semanticKeys = [
    'field',
    'fields',
    'groupFields',
    'groupField',
    'valueFields',
    'valueField',
    'timeField',
    'interval',
    'aggregation',
    'aggregations',
    'featureFields',
    'targetField',
    'outcomeField',
    'categoryField',
  ];
  for (const key of semanticKeys)
    if (canonical(left.parameters[key] ?? null) !== canonical(right.parameters[key] ?? null))
      incompatible(`Incompatible comparison parameter: ${key}`);
  const shape = (result: AnalysisResult) =>
    result.tables
      .map((table) => ({
        id: table.id,
        columns: table.columns
          ? table.columns.map((column) => String(column.name)).sort()
          : Object.keys(table.rows[0] ?? {}).sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  if (canonical(shape(left)) !== canonical(shape(right)))
    incompatible('Result table schemas differ');
  return {
    left,
    right,
    changedParameters: [
      ...new Set([...Object.keys(left.parameters), ...Object.keys(right.parameters)]),
    ]
      .filter(
        (key) =>
          canonical(left.parameters[key] ?? null) !== canonical(right.parameters[key] ?? null),
      )
      .sort(),
  };
}
function incompatible(message: string): never {
  throw new AnalysisResultQueryError('COMPARISON_INCOMPATIBLE', message, 409);
}
function uuid(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
