import { invoke } from "../invoke";

export function fileExistsSafe(path: string): Promise<boolean> {
  return invoke<unknown>("file_exists", { path })
    .then((value) => value === true)
    .catch((error) => {
      console.debug(`[invokeHelpers] file_exists failed for ${path}:`, error);
      return false;
    });
}

export function readEnvVarOptional(name: string): Promise<string | null> {
  return invoke<unknown>("read_env_var", { name })
    .then((value) => typeof value === "string" ? value : null)
    .catch(() => null);
}

export function whichBinaryOptional(name: string): Promise<string | null> {
  return invoke<unknown>("which_binary", { name })
    .then((value) => typeof value === "string" ? value : null)
    .catch((error) => {
      console.debug(`[invokeHelpers] which_binary failed for ${name}:`, error);
      return null;
    });
}
