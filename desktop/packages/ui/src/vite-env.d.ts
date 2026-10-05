interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_FIXTURE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
