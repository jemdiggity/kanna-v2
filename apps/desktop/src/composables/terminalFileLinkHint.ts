export const FILE_LINK_HINT_STORAGE_KEY = "kanna:terminal-file-link-shortcut-hint:v1"

export function showTerminalFileLinkHintOnce(
  storage: Storage,
  info: (message: string) => void,
  message: string,
): boolean {
  if (storage.getItem(FILE_LINK_HINT_STORAGE_KEY) === "1") return false
  storage.setItem(FILE_LINK_HINT_STORAGE_KEY, "1")
  info(message)
  return true
}
