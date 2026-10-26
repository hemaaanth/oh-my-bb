import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

async function canExecute(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function executableAvailable(command: string): Promise<boolean> {
  if (command.includes("/")) return canExecute(command);
  const directories = process.env.PATH?.split(delimiter).filter(Boolean) ?? [];
  for (const directory of directories) {
    if (await canExecute(join(directory, command))) return true;
  }
  return false;
}
