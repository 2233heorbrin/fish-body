/** Remove fish approval hooks from native lifecycle surfaces; keep native checks. */
export function restoreNativeLifecycle(text) {
  text=text.replace(/^\s*(?:w6bAssert(?:Select|Publish|Load)\([^\n]*\);)\r?\n/gm,'');
  text=text.replace(/^\s*const w6bDump = w6bAssertDump\([^\n]*\);\r?\n\s*if \(!w6bDump.allow\) \{[\s\S]*?\r?\n\s*\}\r?\n/m,'\n');
  // Keep only hooks still used by that native module (install transaction or boot wiring).
  return text.replace(/^import \{([^}]+)\} from ["']@deepseek-ai\/fish-hand-admission-gate["'];\r?\n/gm,(line,list)=>{
    const rest=text.replace(line,'');
    const names=list.split(',').map(n=>n.trim()).filter(n=>n&&new RegExp(`\\b${n}\\b`).test(rest));
    return names.length?`import { ${names.join(', ')} } from "@deepseek-ai/fish-hand-admission-gate";\n`:'';
  });
}
