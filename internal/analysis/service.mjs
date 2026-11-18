// Lazy host bridge. No analyzers or candidate modules are imported in the host.
import { analysisInChild } from './process.mjs';
export async function analysisToolAction(args, { frameworkRoot, profileDir } = {}) {
  if (!frameworkRoot || !profileDir) throw Error('FH_ANALYSIS_SCOPE_REQUIRED: body root and current Profile are required');
  return analysisInChild({ args, scope: { frameworkRoot, profileDir } });
}
