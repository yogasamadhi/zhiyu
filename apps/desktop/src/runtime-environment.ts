export function createRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  browserResources?: string,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ...(browserResources ? { PLAYWRIGHT_BROWSERS_PATH: browserResources } : {}),
  };
}
