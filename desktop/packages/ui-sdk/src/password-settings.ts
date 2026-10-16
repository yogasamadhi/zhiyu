export interface PasswordChangeDraft {
  currentPassword: string;
  newPassword: string;
  confirmation: string;
}

export function validatePasswordChange(input: PasswordChangeDraft): string | null {
  if (!input.currentPassword) return '请输入当前密码。';
  if (input.newPassword.length < 12) return '新密码至少需要 12 个字符。';
  if (input.newPassword === input.currentPassword) return '新密码不能与当前密码相同。';
  if (input.newPassword !== input.confirmation) return '两次输入的新密码不一致。';
  return null;
}
