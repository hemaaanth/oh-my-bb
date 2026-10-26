export interface Diagnostic { severity: "error" | "warning"; line: number; column: number; message: string }
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}: ${diagnostic.message}`).join("\n");
}
