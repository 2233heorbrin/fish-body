import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { ProfileData } from './profile-data.js'

/** UI, backend and native transaction use the same saved location and upgrade inputs. */
export function bodyProfileData(context, config = {}) {
  return new ProfileData(context.dir, 'body', { legacyRoots: () => {
    const roots = []
    if (config.fishRoot) roots.push({ source: 'config.fishRoot', root: config.fishRoot })
    const stateFile = join(context.dir, 'fish-body-state.json')
    if (existsSync(stateFile)) {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (saved.frameworkRoot) roots.push({ source: stateFile + ':frameworkRoot', root: saved.frameworkRoot })
    }
    // A stopped-host CLI can run before the data page has migrated an explicit
    // legacy fishRoot. Resolve its declaration with the Host's own patch rules.
    if (context.installAnchor) {
      const { loadProfileDirectory, loadOptionalPatches, composeEntries } = createRequire(context.installAnchor)('@deepseek-ai/dsh-app-boot')
      const profile = loadProfileDirectory('dsh', context.dir, context.installAnchor)
      const home = dirname(dirname(context.dir))
      const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches,
        loadOptionalPatches('dsh', join(home, 'cordis.patch.yml')) ?? []])
      const body = rows.find(row => row.id === 'fish-body')
      if (body?.config?.fishRoot) {
        if (typeof body.config.fishRoot !== 'string') throw new Error('FISH_BINDING_INVALID: fish-body.config.fishRoot requires a resolved absolute directory')
        roots.push({ source: 'fish-body.config.fishRoot (native composition)', root: body.config.fishRoot })
      }
    }
    return roots
  } })
}
