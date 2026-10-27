declare module '*.css';
interface ImportMeta {
  readonly env: {
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly VITE_FIXTURE_URL?: string;
  };
}
