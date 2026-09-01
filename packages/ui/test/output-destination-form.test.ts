import { describe, expect, it } from 'vitest';
import {
  buildOutputDestinationInput,
  defaultOutputDestinationDraft,
  outputDestinationSummary,
} from '../src/output-destination-form.js';

describe('output destination form', () => {
  it('builds a multi-event webhook config', () => {
    expect(
      buildOutputDestinationInput(
        {
          ...defaultOutputDestinationDraft,
          target: 'https://example.com/hook',
          secret: 'test-secret',
          webhookEvents: ['run.failed', 'quality.issue.detected'],
        },
        false,
      ),
    ).toMatchObject({
      type: 'webhook',
      config: {
        url: 'https://example.com/hook',
        events: ['run.failed', 'quality.issue.detected'],
      },
    });
  });

  it('builds each file and cloud destination config', () => {
    expect(
      buildOutputDestinationInput(
        { ...defaultOutputDestinationDraft, type: 'local-directory', target: 'exports/daily' },
        false,
      ),
    ).toMatchObject({
      type: 'local-directory',
      config: { format: 'csv', updateLatest: true, basePath: 'exports/daily' },
    });
    expect(
      buildOutputDestinationInput(
        {
          ...defaultOutputDestinationDraft,
          type: 'google-sheets',
          spreadsheetId: 'sheet-id-123',
          columns: 'title, url',
          serviceAccountJson: JSON.stringify({
            client_email: 'service@example.com',
            private_key: '-----BEGIN PRIVATE KEY-----\ntest',
          }),
        },
        false,
      ),
    ).toMatchObject({
      type: 'google-sheets',
      config: { spreadsheetId: 'sheet-id-123', columns: ['title', 'url'] },
    });
    expect(
      buildOutputDestinationInput(
        {
          ...defaultOutputDestinationDraft,
          type: 's3',
          bucket: 'archive',
          endpoint: 'https://s3.example.com',
        },
        true,
      ),
    ).toMatchObject({ type: 's3', config: { bucket: 'archive', region: 'us-east-1' } });
  });

  it('rejects incomplete cloud credentials before sending them to Runtime', () => {
    expect(() =>
      buildOutputDestinationInput(
        {
          ...defaultOutputDestinationDraft,
          type: 's3',
          bucket: 'archive',
          accessKeyId: 'access',
        },
        false,
      ),
    ).toThrow(/Secret Access Key/);
    expect(() =>
      buildOutputDestinationInput(
        {
          ...defaultOutputDestinationDraft,
          type: 'google-sheets',
          spreadsheetId: 'sheet-id-123',
          serviceAccountJson: '{}',
        },
        false,
      ),
    ).toThrow(/client_email/);
    expect(() =>
      buildOutputDestinationInput(
        { ...defaultOutputDestinationDraft, type: 'local-directory', target: '../escape' },
        false,
      ),
    ).toThrow(/安全相对路径/);
    expect(() =>
      buildOutputDestinationInput(
        {
          ...defaultOutputDestinationDraft,
          type: 'local-directory',
          pathTemplate: 'products/latest.csv',
        },
        true,
      ),
    ).toThrow(/\{runId\}/);
    expect(() =>
      buildOutputDestinationInput(
        {
          ...defaultOutputDestinationDraft,
          type: 's3',
          bucket: 'archive',
          pathTemplate: 'products/latest.csv',
        },
        true,
      ),
    ).toThrow(/\{runId\}/);
  });

  it('shows the non-secret Google service-account email in destination summaries', () => {
    const now = new Date().toISOString();
    const summary = outputDestinationSummary({
      id: crypto.randomUUID(),
      name: 'Sheets',
      type: 'google-sheets',
      config: {
        spreadsheetId: 'sheet-id-123',
        sheetName: 'Records',
        mode: 'auto',
        columns: [],
        clientEmail: 'service@example.com',
      },
      credentialRef: 'encrypted-ref',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    expect(summary).toContain('service@example.com');
    expect(summary).not.toContain('private_key');
  });
});
