export function resolveDevelopmentFixture(
  development: boolean,
  configuredUrl: string | undefined,
): string | undefined {
  if (!development || !configuredUrl) return undefined;
  return configuredUrl.replace(/\/$/, '');
}
