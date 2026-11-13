// Body-internal infrastructure, not an independently selectable plugin.
// Validate the fixed bundled bytes before executing, retain Cordis disposal.
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function activateRuntimePlugin(ctx) {
  const root = await realpath(dirname(fileURLToPath(import.meta.url)))
  const entry = await realpath(resolve(root, 'utility-sha256.js'))
  const rel = relative(root, entry)
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('FH_GATE_CONTENT_PATH')
  const hash = createHash('sha256').update(await readFile(entry)).digest('hex')
  if (hash !== '7238d6fd21b5a98c78fbef91ca05940add5cf371fe28e4774663d59da93eeda9') throw new Error('FH_GATE_CONTENT_HASH')
  const mod = await import(pathToFileURL(entry).href)
  if (mod.PLUGIN_ID !== 'utility.sha256' || mod.PLUGIN_VERSION !== '1.0.0' || mod.TOOL_NAME !== 'utility_sha256') throw new Error('FH_GATE_MODULE_INTERFACE')
  return mod.apply(ctx)
}
