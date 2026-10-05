export async function revokeWorkspaceSession(
  revoke: () => Promise<void>,
  onRevoked: () => void,
  onFailure: (reason: unknown) => void,
): Promise<void> {
  try {
    await revoke();
  } catch (reason) {
    onFailure(reason);
    throw reason;
  }
  onRevoked();
}
