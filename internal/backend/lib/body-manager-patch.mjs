// Maintain the narrow seam in DSH's native manager and its existing notice UI.
// No selection file is written here; no approvals, loader or restart are added.
export function patchBodyManager(text) {
  return patchMarketManager(patchBundleManager(patchComponentManager(text)))
}

function patchMarketManager(text) {
  if(text.includes('registerMarketManager(this.profile.dir'))return text
  let out=text.replace('runBodySwitchChange, bodyUsesBundle }','runBodySwitchChange, bodyUsesBundle, registerMarketManager }')
  const anchor='this.profile = ctx.profileContext;'
  if(!out.includes(anchor))throw new Error('market native manager lifecycle anchor changed')
  out=out.replace(anchor,anchor+ '\n            ctx.effect(() => registerMarketManager(this.profile.dir, enabled => this.setBundleEnabled("fish-body", enabled)));')
  return out
}

function patchComponentManager(text) {
  if (text.includes('const fishBodyChange = () => this.change(')) return text
  let out = text.replace('w6bNoteLocalRestore, w6bAssertInstall }', 'w6bNoteLocalRestore, w6bAssertInstall, runBodySwitchChange }')
  const start = out.indexOf('\t\tsetPluginEnabled(id, enabled) {')
  const end = out.indexOf('\n\t\t/** Select or remove a bundle', start)
  if (start < 0 || end < 0) throw new Error('body-manager native lifecycle anchors changed')
  let method = out.slice(start, end)
  method = method.replace('setPluginEnabled(id, enabled)', 'async setPluginEnabled(id, enabled)')
    .replace('return this.change(', 'const fishBodyChange = () => this.change(')
  const close = method.lastIndexOf('\n\t\t}')
  method = method.slice(0, close) + `
            let bodyRow;
            try { bodyRow = (await this.listPlugins()).find(item => item.entryId === id); }
            catch { return fishBodyChange(); }
            if (bodyRow?.patchId !== "fish-body" || bodyRow.readOnlyReason !== undefined) return fishBodyChange();
            return runBodySwitchChange({ profileDir: this.profile.dir, enabled, operation: fishBodyChange,
                changed: () => this.ownerContext.emit("plugin-manager/changed", { reason: "plugin" }) });` + method.slice(close)
  out = out.slice(0, start) + method + out.slice(end)
  out = out.replaceAll('stage: "prepare-approve-builds" });', 'stage: "prepare-approve-builds", context: { dir: this.profile.dir } });')
    .replaceAll('stage: "prepare-read-restored-files" });', 'stage: "prepare-read-restored-files", context: { dir: this.profile.dir } });')
    .replaceAll('stage: "install-pnpm" });', 'stage: "install-pnpm", context: { dir: this.profile.dir } });')
    .replace('reason: "installBundle 退出路径" });', 'reason: "installBundle 退出路径", context: { dir: this.profile.dir } });')
    .replace('files: files instanceof Map ? [...files.keys()] : [] });', 'files: files instanceof Map ? [...files.keys()] : [], context: { dir: this.profile.dir } });')
  if (!out.includes('runBodySwitchChange }')) throw new Error('body-manager gate import anchor changed')
  return out
}

export function patchBodyManagerClient(text) {
  let out = patchComponentClient(text)
  if (!out.includes('if (!enabled && packageName === "fish-body")')) {
    const anchor = 'const result = await this.ctx.remote.pluginManager.setBundleEnabled(packageName, enabled);'
    if (!out.includes(anchor)) throw new Error('body bundle client action anchor changed')
    out = out.replace(anchor, `if (!enabled && packageName === "fish-body")
                                this.patch({ notice: { kind: "body-closing", seq: ++this.noticeSeq } });
                            ${anchor}`)
  }
  return out
}

function patchComponentClient(text) {
  if (text.includes('case "body-closing":')) return text
  const out = text.replace('switch (notice.kind) {', `switch (notice.kind) {
                case "body-closing": return "鱼的身体正在关闭：等待当前操作收尾，不再启动新的身体流程。";`)
    .replace('const result = await this.ctx.remote.pluginManager.setPluginEnabled(entryId, enabled);',
      `if (!enabled && (entryId === "fish-body" || entryId.endsWith(":fish-body")))
                                this.patch({ notice: { kind: "body-closing", seq: ++this.noticeSeq } });
                            const result = await this.ctx.remote.pluginManager.setPluginEnabled(entryId, enabled);`)
  if (out === text || !out.includes('kind: "body-closing"')) throw new Error('body-manager Client anchors changed')
  return out
}

function patchBundleManager(text) {
  if (text.includes('const fishBodyBundleChange = () => this.change(')) return text
  let out = text.replace('w6bAssertInstall, runBodySwitchChange }', 'w6bAssertInstall, runBodySwitchChange, bodyUsesBundle }')
  const component = 'if (bodyRow?.patchId !== "fish-body" || bodyRow.readOnlyReason !== undefined) return fishBodyChange();'
  if (!out.includes(component)) throw new Error('body component lifecycle anchor changed')
  out = out.replace(component, component + '\n            if (bodyUsesBundle(this.profile.dir)) return this.setBundleEnabled("fish-body", enabled);')
  const start=out.indexOf('\t\tsetBundleEnabled(name, enabled) {')
  const end=out.indexOf('\n\t\t/**', start)
  if(start<0||end<0)throw new Error('body bundle lifecycle anchor changed')
  let method=out.slice(start,end).replace('return this.change(', 'const fishBodyBundleChange = () => this.change(')
  const close=method.lastIndexOf('\n\t\t}')
  method=method.slice(0,close)+`
            if (name !== "fish-body") return fishBodyBundleChange();
            return runBodySwitchChange({ profileDir: this.profile.dir, enabled, operation: fishBodyBundleChange,
                changed: () => this.ownerContext.emit("plugin-manager/changed", { reason: "bundle" }) });`+method.slice(close)
  out=out.slice(0,start)+method+out.slice(end)
  const list='return Promise.resolve(bundles);'
  if(!out.includes(list))throw new Error('body bundle inventory anchor changed')
  // Installed implementation dependency is not a second public plugin switch.
  out=out.replace(list, 'return Promise.resolve(bodyUsesBundle(this.profile.dir) ? bundles.filter(item => item.name !== "fish-hand-utility-sha256") : bundles);')
  const select='async selectBundle(name, enabled) {'
  out=out.replace(select, select+`
            if (enabled && name === "fish-hand-utility-sha256" && bodyUsesBundle(this.profile.dir))
                throw new Error("FH_BODY_COMPONENT_MANAGED: 内置 SHA-256 随鱼的身体（fish_body）总开关管理，请使用身体主项。");`)
  if(!out.includes('runBodySwitchChange, bodyUsesBundle }'))throw new Error('body bundle import anchor changed')
  return out
}
