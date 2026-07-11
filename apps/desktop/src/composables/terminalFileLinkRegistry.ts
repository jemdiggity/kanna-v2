export interface RegisteredTerminalFileLinkProvider {
  activateLatest(): Promise<boolean>
}

const providers = new Map<string, RegisteredTerminalFileLinkProvider>()

export function registerTerminalFileLinkProvider(
  sessionId: string,
  provider: RegisteredTerminalFileLinkProvider,
): () => void {
  providers.set(sessionId, provider)
  return () => {
    if (providers.get(sessionId) === provider) providers.delete(sessionId)
  }
}

export async function openLatestTerminalFileLink(sessionId: string): Promise<boolean> {
  return await providers.get(sessionId)?.activateLatest() ?? false
}

export function clearTerminalFileLinkRegistryForTests(): void {
  providers.clear()
}
