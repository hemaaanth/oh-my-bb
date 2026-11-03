export function verifyBrowserRuntime(directory: string): {
  inputs: Record<string, { mode: number; sha256: string }>;
  version: string;
  sourceCommit: string;
  inputsSha256: string;
  archiveSha256: string;
};
