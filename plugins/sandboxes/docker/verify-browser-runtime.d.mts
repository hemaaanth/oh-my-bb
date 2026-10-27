export function verifyBrowserRuntime(directory: string): {
  version: string;
  sourceCommit: string;
  inputsSha256: string;
  archiveSha256: string;
};
