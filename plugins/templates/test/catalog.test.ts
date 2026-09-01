import { crawlPlanDefinitionSchema, taskCreateSchema, taskTemplateSchema } from '@zhiyun/shared';
import { describe, expect, it } from 'vitest';
import {
  getTaskTemplate,
  instantiateTaskTemplateDefinition,
  taskTemplateCatalog,
  validateTaskTemplateCatalog,
} from '../src/index.js';

const workflowFixtures = [
  {
    id: 'list-page',
    parameters: { container: '.card', titleSelector: '.title', linkSelector: 'a.details' },
    assertion: (definition: ReturnType<typeof instantiateTaskTemplateDefinition>) => {
      expect(definition.list.rule.type).toBe('css');
      expect(definition.detail).toBeUndefined();
    },
  },
  {
    id: 'list-detail',
    parameters: {
      container: '.card',
      titleSelector: '.title',
      linkSelector: 'a.details',
      detailContainer: 'main.article',
      contentSelector: '.content',
    },
    assertion: (definition: ReturnType<typeof instantiateTaskTemplateDefinition>) => {
      expect(definition.detail?.rule.type).toBe('css');
      expect(definition.detail?.urlField).toBe('url');
    },
  },
  {
    id: 'next-pagination',
    parameters: {
      container: '.card',
      titleSelector: '.title',
      linkSelector: 'a.details',
      nextSelector: 'a.next',
    },
    assertion: (definition: ReturnType<typeof instantiateTaskTemplateDefinition>) => {
      expect(definition.pagination).toMatchObject({ type: 'next', selector: 'a.next' });
    },
  },
  {
    id: 'infinite-scroll',
    parameters: { container: '.card', titleSelector: '.title', linkSelector: 'a.details' },
    assertion: (definition: ReturnType<typeof instantiateTaskTemplateDefinition>) => {
      expect(definition.pagination).toMatchObject({ type: 'infinite', maxScrolls: 10 });
    },
  },
  {
    id: 'json-api',
    parameters: { containerPath: '$.items', idPath: '$.id', titlePath: '$.title' },
    assertion: (definition: ReturnType<typeof instantiateTaskTemplateDefinition>) => {
      expect(definition.list.rule).toMatchObject({ type: 'json', container: '$.items' });
    },
  },
  {
    id: 'sitemap-details',
    parameters: { detailContainer: 'main.article', titleSelector: 'h1' },
    assertion: (definition: ReturnType<typeof instantiateTaskTemplateDefinition>) => {
      expect(definition.discovery).toMatchObject({ type: 'sitemap', sameOrigin: true });
      expect(definition.detail?.rule.type).toBe('css');
    },
  },
  {
    id: 'authenticated-browser',
    parameters: { container: '.card', titleSelector: '.title', linkSelector: 'a.details' },
    assertion: (definition: ReturnType<typeof instantiateTaskTemplateDefinition>) => {
      expect(definition.list.mode).toBe('browser');
    },
  },
  {
    id: 'change-monitor',
    parameters: { container: '.product', titleSelector: '.price', linkSelector: 'a.details' },
    assertion: (definition: ReturnType<typeof instantiateTaskTemplateDefinition>) => {
      expect(definition.dedupe).toMatchObject({ strategy: 'fields', fields: ['url'] });
    },
  },
] as const;

describe('Task Template catalog', () => {
  it('contains eight unique, versioned built-in workflows', () => {
    expect(taskTemplateCatalog).toHaveLength(8);
    expect(
      new Set(taskTemplateCatalog.map((template) => `${template.id}@${template.version}`)).size,
    ).toBe(8);
  });

  it.each(workflowFixtures)('$id instantiates into executable task and rule schemas', (fixture) => {
    const template = getTaskTemplate(fixture.id);
    expect(template).not.toBeNull();
    const parsedTemplate = taskTemplateSchema.parse(template);
    const definition = instantiateTaskTemplateDefinition(parsedTemplate, fixture.parameters);
    expect(crawlPlanDefinitionSchema.parse(definition)).toEqual(definition);
    expect(JSON.stringify(definition)).not.toContain('{{');
    fixture.assertion(definition);

    const task = taskCreateSchema.parse({
      ...parsedTemplate.taskDefaults,
      name: parsedTemplate.name,
      startUrl: 'https://www.wikipedia.org/',
      instruction: parsedTemplate.taskDefaults.instruction ?? parsedTemplate.description,
    });
    expect(task.startUrl).toBe('https://www.wikipedia.org/');
    expect(task.networkPolicy.allowPrivateNetworks).toBe(false);
  });

  it('enables content monitoring only for the change template', () => {
    const template = getTaskTemplate('change-monitor');
    expect(
      template?.qualityPolicy?.rules.find((rule) => rule.kind === 'content-change')?.enabled,
    ).toBe(true);
    expect(
      taskTemplateCatalog
        .filter((candidate) => candidate.id !== 'change-monitor')
        .every(
          (candidate) =>
            !candidate.qualityPolicy?.rules.some(
              (rule) => rule.kind === 'content-change' && rule.enabled,
            ),
        ),
    ).toBe(true);
  });

  it('rejects duplicate template versions', () => {
    const template = structuredClone(taskTemplateCatalog[0]!);
    expect(() => validateTaskTemplateCatalog([template, structuredClone(template)])).toThrow(
      /Duplicate Task Template/u,
    );
  });

  it.each(['password', 'apiToken', 'client_secret', 'credentialRef', 'private_key', 'accessKeyId'])(
    'rejects a recursively nested sensitive key: %s',
    (sensitiveKey) => {
      const candidate = maliciousCandidate({ metadata: { nested: { [sensitiveKey]: 'value' } } });
      expect(() => validateTaskTemplateCatalog([candidate])).toThrow(/Sensitive key/u);
    },
  );

  it('rejects sensitive parameter names and embedded private key material', () => {
    const parameterCandidate = maliciousCandidate({
      parameters: [
        ...taskTemplateCatalog[0]!.parameters,
        { key: 'accessToken', label: 'Access value', type: 'string', required: true },
      ],
    });
    expect(() => validateTaskTemplateCatalog([parameterCandidate])).toThrow(
      /Sensitive parameter key/u,
    );

    const keyCandidate = maliciousCandidate({
      metadata: { value: '-----BEGIN PRIVATE KEY-----\nmaterial' },
    });
    expect(() => validateTaskTemplateCatalog([keyCandidate])).toThrow(/Private key material/u);
  });

  it.each([
    { developmentFixture: true },
    { metadata: { marker: 'test-fixture' } },
    { metadata: { marker: 'demo-only' } },
  ])('rejects development-only fixture markers', (extra) => {
    expect(() => validateTaskTemplateCatalog([maliciousCandidate(extra)])).toThrow(
      /Development fixture marker/u,
    );
  });

  it.each([
    'http://localhost:45100/items',
    'http://worker.localhost/items',
    'http://127.1/items',
    'http://2130706433/items',
    'http://10.20.30.40/items',
    'http://172.31.20.10/items',
    'http://192.168.20.10/items',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/items',
    'http://[fc00::1]/items',
    'http://[fd12:3456::1]/items',
    'http://[fe80::1]/items',
    'http://[::ffff:127.0.0.1]/items',
    'http://[::ffff:10.0.0.1]/items',
  ])('rejects private, link-local or loopback template URL %s', (url) => {
    const candidate = maliciousCandidate({ metadata: { sourceUrl: url } });
    expect(() => validateTaskTemplateCatalog([candidate])).toThrow(
      /Private, loopback or development URL/u,
    );
  });

  it('rejects URL credentials and non-HTTP URL schemes', () => {
    expect(() =>
      validateTaskTemplateCatalog([
        maliciousCandidate({ metadata: { sourceUrl: 'https://user:pass@www.wikipedia.org/' } }),
      ]),
    ).toThrow(/URL credentials/u);
    expect(() =>
      validateTaskTemplateCatalog([
        maliciousCandidate({
          metadata: { sourceUrl: 'https://www.wikipedia.org/?access_token=value' },
        }),
      ]),
    ).toThrow(/URL credential parameters/u);
    expect(() =>
      validateTaskTemplateCatalog([
        maliciousCandidate({ metadata: { sourceUrl: 'ftp://ftp.gnu.org/' } }),
      ]),
    ).toThrow(/Only HTTP and HTTPS/u);
  });

  it('accepts a public HTTPS URL in otherwise safe extension data', () => {
    const [validated] = validateTaskTemplateCatalog([
      maliciousCandidate({ metadata: { sourceUrl: 'https://www.wikipedia.org/' } }),
    ]);
    expect(validated?.id).toBe('manifest-check');
  });
});

function maliciousCandidate(extension: Record<string, unknown>): unknown {
  return {
    ...structuredClone(taskTemplateCatalog[0]!),
    id: 'manifest-check',
    version: 99,
    ...extension,
  };
}
