import { describe, expect, it } from 'vitest';
import { validatePasswordChange } from '../src/password-settings.js';

describe('password settings', () => {
  it('requires the current password and a distinct confirmed 12-character password', () => {
    expect(
      validatePasswordChange({
        currentPassword: '',
        newPassword: 'new password value',
        confirmation: 'new password value',
      }),
    ).toContain('当前密码');
    expect(
      validatePasswordChange({
        currentPassword: 'current-pass',
        newPassword: 'short',
        confirmation: 'short',
      }),
    ).toContain('12');
    expect(
      validatePasswordChange({
        currentPassword: 'same password value',
        newPassword: 'same password value',
        confirmation: 'same password value',
      }),
    ).toContain('不能');
    expect(
      validatePasswordChange({
        currentPassword: 'current password value',
        newPassword: 'new password value',
        confirmation: 'different value',
      }),
    ).toContain('不一致');
    expect(
      validatePasswordChange({
        currentPassword: 'current password value',
        newPassword: 'new password value',
        confirmation: 'new password value',
      }),
    ).toBeNull();
  });
});
