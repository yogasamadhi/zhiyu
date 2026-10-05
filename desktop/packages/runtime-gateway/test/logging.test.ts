import { describe, expect, it, vi } from 'vitest';
import { redactSensitiveUrl, secureRuntimeLogger, serializeRuntimeRequest } from '../src/index.js';

describe('Runtime Gateway production logging', () => {
  it('redacts one-time tokens and credentials from request URLs', () => {
    const serialized = serializeRuntimeRequest({
      method: 'GET',
      url: '/?invitation=invite-secret&screen=compact#password-reset=reset-secret',
      headers: { cookie: 'zhiyun_session=session-secret' },
      remoteAddress: '127.0.0.1',
    });

    expect(serialized).toEqual({
      method: 'GET',
      url: '/?invitation=%5BREDACTED%5D&screen=compact#password-reset=%5BREDACTED%5D',
      remoteAddress: '127.0.0.1',
    });
    expect(JSON.stringify(serialized)).not.toContain('invite-secret');
    expect(JSON.stringify(serialized)).not.toContain('reset-secret');
    expect(JSON.stringify(serialized)).not.toContain('session-secret');
    expect(redactSensitiveUrl('https://user:pass@example.com/path?token=secret')).toBe(
      'https://example.com/path?token=%5BREDACTED%5D',
    );
  });

  it('forces header redaction while preserving caller logger options', () => {
    const options = secureRuntimeLogger({
      level: 'info',
      redact: { paths: ['custom.secret'], censor: '***' },
      serializers: { response: () => ({ statusCode: 200 }) },
    }) as Record<string, unknown>;
    const redaction = options.redact as { paths: string[]; censor: string };
    const serializers = options.serializers as Record<string, unknown>;
    const hooks = options.hooks as {
      logMethod(
        this: unknown,
        inputArguments: unknown[],
        method: (...arguments_: unknown[]) => void,
      ): void;
    };

    expect(options.level).toBe('info');
    expect(redaction.censor).toBe('***');
    expect(redaction.paths).toEqual(
      expect.arrayContaining([
        'custom.secret',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
      ]),
    );
    expect(serializers.req).toBe(serializeRuntimeRequest);
    expect(serializers.response).toBeTypeOf('function');

    const write = vi.fn();
    hooks.logMethod.call(
      {},
      ['Route GET:/?invitation=one-time-secret&screen=compact not found'],
      write,
    );
    expect(write).toHaveBeenCalledWith(
      'Route GET:/?invitation=[REDACTED]&screen=compact not found',
    );
  });
});
