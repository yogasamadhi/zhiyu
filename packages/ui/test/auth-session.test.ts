import { describe, expect, it, vi } from 'vitest';
import { revokeWorkspaceSession } from '../src/auth-session.js';

describe('workspace logout transition', () => {
  it('switches to login only after the server confirms revocation', async () => {
    const revoked = vi.fn();
    const failed = vi.fn();
    await revokeWorkspaceSession(async () => undefined, revoked, failed);
    expect(revoked).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
  });

  it('keeps the authenticated UI visible and surfaces a logout failure', async () => {
    const reason = new Error('revocation persistence failed');
    const revoked = vi.fn();
    const failed = vi.fn();
    await expect(
      revokeWorkspaceSession(async () => Promise.reject(reason), revoked, failed),
    ).rejects.toBe(reason);
    expect(revoked).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(reason);
  });
});
