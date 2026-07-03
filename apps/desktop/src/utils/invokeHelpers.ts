import { invoke } from "../invoke";

export function fileExistsSafe(path: string): Promise<boolean> {
  return invoke<boolean>("file_exists", { path }).catch((error) => {
    console.debug(`[invokeHelpers] file_exists failed for ${path}:`, error);
    return false;
  });
}

export function readEnvVarOptional(name: string): Promise<string | null> {
  return invoke<string>("read_env_var", { name }).catch(() => null);
}

export function whichBinaryOptional(name: string): Promise<string | null> {
  return invoke<string>("which_binary", { name }).catch((error) => {
    console.debug(`[invokeHelpers] which_binary failed for ${name}:`, error);
    return null;
  });
}
