// Original bytes and the user's update channel are separate identities. The
// native host uses pnpm's resolver API to keep both; it owns lock/recovery.
export function originalSourceOptions(original, sourcePreservationVersion) {
  if (!original || /^(?:file|link):/i.test(original.requestedSpec ?? '')) return undefined;
  if (sourcePreservationVersion !== 1) throw Object.assign(
    new Error('FH_SOURCE_PRESERVATION_UNAVAILABLE: 原包远端来源保留需要匹配的宿主扩展'),
    {code:'FH_SOURCE_PRESERVATION_UNAVAILABLE'});
  return {fixedPackageSources:[original]};
}
