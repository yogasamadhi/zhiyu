import type { DatasetSettings, OutputDestination } from '@zhiyun/contracts';

export type ExtendedOutputDestinationType =
  OutputDestination['type'] | 'local-directory' | 'google-sheets' | 's3';

/**
 * Kept structurally compatible with the shared destination contract while the
 * P1 destination discriminants are rolled out across the workspace.
 */
export type OutputDestinationLike = Omit<OutputDestination, 'type' | 'config'> & {
  type: ExtendedOutputDestinationType;
  // Adapters validate their own allowlisted config after the shared HTTP/storage boundary.
  config: Record<string, unknown>;
};

export interface OutputRecord {
  sourceUrl: string;
  data: Record<string, unknown>;
}

export type OutputFileFormat = 'csv' | 'jsonl' | 'parquet';

export interface OutputArtifactSpec {
  format: OutputFileFormat;
  fields: string[];
  includeSourceUrl: boolean;
  fingerprint: string;
}

export interface MaterializedOutputArtifact {
  id: string;
  path: string;
  format: OutputFileFormat;
  delivered: number;
  sha256: string;
  bytes: number;
  fields: string[];
}

export interface OutputDeliveryInput {
  destination: OutputDestinationLike;
  taskId: string;
  runId: string;
  datasetSettings: DatasetSettings;
  datasetStats?: {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
    current: number;
  };
  records: AsyncIterable<OutputRecord> | Iterable<OutputRecord>;
  credential: unknown;
  artifact?: MaterializedOutputArtifact;
  signal?: AbortSignal;
}

export interface OutputDeliveryResult {
  responseStatus: number | null;
  delivered: number;
  format?: OutputFileFormat | null;
  artifactId?: string | null;
  finalLocation?: string | null;
  sha256?: string | null;
  deliveredRecordCount?: number | null;
}

export interface OutputAdapter {
  readonly type: ExtendedOutputDestinationType;
  test(input: Pick<OutputDeliveryInput, 'destination' | 'credential' | 'signal'>): Promise<void>;
  deliver(input: OutputDeliveryInput): Promise<OutputDeliveryResult>;
}
