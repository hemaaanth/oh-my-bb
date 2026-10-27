import manifest from "./bb.json";
import versions from "./versions.json";
import installer from "./setup.py" with { type: "text" };
import { setupRecipeSchema } from "../../setup-contract.js";

// This snapshot preserves old opt-ins; new bindings always review a workspace.
export const migratedSecurityRecipe = setupRecipeSchema.parse({
  name: "Security tools (migrated)",
  script: manifest.agentSetup.script,
  command: manifest.scripts[manifest.agentSetup.script as "prepare-tools"].command,
  env: manifest.agentSetup.env,
  files: { "bb.json": JSON.stringify(manifest), "setup.py": installer, "versions.json": JSON.stringify(versions) },
});
