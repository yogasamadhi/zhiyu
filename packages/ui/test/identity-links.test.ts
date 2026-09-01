import { describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceTokenLink,
  consumeWorkspaceTokenAction,
  invitationStatus,
  withoutWorkspaceTokenAction,
  workspaceTokenAction,
} from '../src/identity-links.js';

describe('workspace identity links', () => {
  it('keeps one-time secrets in a link without leaking the current route', () => {
    expect(
      buildWorkspaceTokenLink('https://zhiyun.example/members?tab=active', 'invitation', 'a b'),
    ).toBe('https://zhiyun.example/#invitation=a+b');
    expect(workspaceTokenAction('#invitation=a+b')).toEqual({
      kind: 'invitation',
      token: 'a b',
    });
    expect(workspaceTokenAction('#password-reset=reset-secret')).toEqual({
      kind: 'password-reset',
      token: 'reset-secret',
    });
    expect(withoutWorkspaceTokenAction('#invitation=secret&screen=compact')).toBe(
      '#screen=compact',
    );
    const replacements: string[] = [];
    expect(
      consumeWorkspaceTokenAction(
        'https://zhiyun.example/?language=zh#invitation=one-time-secret&screen=compact',
        (location) => replacements.push(location),
      ),
    ).toEqual({ kind: 'invitation', token: 'one-time-secret' });
    expect(replacements).toEqual(['/?language=zh#screen=compact']);
    expect(replacements.join('')).not.toContain('one-time-secret');
  });

  it('distinguishes active and terminal invitation states', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));
    expect(
      invitationStatus({
        acceptedAt: null,
        revokedAt: null,
        expiresAt: '2026-09-01T00:00:00.000Z',
      }),
    ).toBe('active');
    expect(
      invitationStatus({
        acceptedAt: null,
        revokedAt: null,
        expiresAt: '2026-08-30T00:00:00.000Z',
      }),
    ).toBe('expired');
    expect(
      invitationStatus({
        acceptedAt: '2026-08-30T00:00:00.000Z',
        revokedAt: null,
        expiresAt: '2026-09-01T00:00:00.000Z',
      }),
    ).toBe('accepted');
    vi.useRealTimers();
  });
});
