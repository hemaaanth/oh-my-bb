export interface SetupFile {
  path: string;
  op: "managed-block" | "managed-file" | "json-merge" | "omp-settings" | "pi-settings";
  marker?: string;
  key?: string;
  content: string;
  sha256: string;
}
export interface SetupResult {
  files: Array<{ path: string; status: "current" | "missing" | "stale"; changed: boolean; backup: string | null }>;
}
export const BEGIN: string;
export function ompSnippet(baseUrl: string, models?: readonly unknown[]): string;
export function upsertOmpProvider(text: string, baseUrl: string, models?: readonly unknown[]): string;
export function sha256(content: string): string;
export function validateSetupPath(value: string): string;
export function applySetupFiles(home: string, files: readonly SetupFile[]): Promise<SetupResult>;
export function checkSetupFiles(home: string, files: readonly SetupFile[]): Promise<SetupResult>;
