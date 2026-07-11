export function buildCloudTaskId({
  ownerDesktopId,
  localRepoId,
  ownerLocalTaskId
}: {
  ownerDesktopId: string;
  localRepoId: string;
  ownerLocalTaskId: string;
}): string {
  return `cloud:${ownerDesktopId}:${localRepoId}:${ownerLocalTaskId}`;
}

export function canonicalizeTaskActionId({
  canonicalTaskId,
  ownerDesktopId,
  localRepoId,
  sourceLocalTaskId,
  responseLocalTaskId
}: {
  canonicalTaskId: string;
  ownerDesktopId: string;
  localRepoId: string;
  sourceLocalTaskId: string;
  responseLocalTaskId: string;
}): string {
  if (responseLocalTaskId === sourceLocalTaskId) {
    return canonicalTaskId;
  }

  return buildCloudTaskId({
    ownerDesktopId,
    localRepoId,
    ownerLocalTaskId: responseLocalTaskId
  });
}
