import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProjectSetupRecipe { machineSetupScript: string; workspaceSetupScript: string }
/** Setup source belongs to the project. Reading it does not execute it. */
export function setupRecipeForProject(projectPath: string | null): ProjectSetupRecipe | null {
  if (!projectPath) return null;
  const read = (name: string) => {
    const file = join(projectPath, ".bb", "setup", name);
    return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  };
  const machineSetupScript = read("machine.sh");
  const workspaceSetupScript = read("workspace.sh");
  return machineSetupScript || workspaceSetupScript ? { machineSetupScript, workspaceSetupScript } : null;
}
