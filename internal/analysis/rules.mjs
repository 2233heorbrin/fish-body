// Syntactic observations only: names do not establish runtime semantics.
export const ruleVersion = 'spike-2';
export const languages = {
  '.js':['JavaScript','call_expression'], '.mjs':['JavaScript','call_expression'], '.cjs':['JavaScript','call_expression'],
  '.ts':['TypeScript','call_expression'], '.tsx':['Tsx','call_expression'],
  '.py':['Python','call'], '.rs':['Rust','call_expression'], '.c':['C','call_expression'], '.cpp':['Cpp','call_expression']
};
export function classifyCall(text, language) {
  const result=[],callee=text.slice(0,text.indexOf('(')).trim();
  const mark=(category,condition)=>{if(condition)result.push({category,callee});};
  mark('tool-registration',/\.tools\.register$/.test(callee));
  mark('tool-definition',/^(?:defineTool|tool)$/.test(callee));
  mark('prompt-injection',/\.systemPrompt\.(?:section|append|prepend|add)$/.test(callee));
  mark('listener',/\.(?:on|once|addEventListener)$/.test(callee));
  mark('timer',/^(?:setInterval|setTimeout|clearInterval|clearTimeout)$/.test(callee)||/\.timer\.(?:interval|timeout)$/.test(callee));
  mark('route',/\.webServer\.register$/.test(callee)||/\.(?:get|post|use)$/.test(callee)&&/router|app/.test(callee));
  mark('state-access',/^(?:store\.|this\.(?:store|paths)\.)/.test(callee)||/^(?:fs\.(?:write|append)|writeJson|writeText|appendLine|writeIfMissing)/.test(callee)||/\.set$/.test(callee));
  mark('process',/^(?:spawn|execFile|exec|fork|subprocess\.(?:run|Popen|call|check_output))$/.test(callee));
  mark('external-resource',/^(?:fetch|https?\.(?:get|request)|os\.getenv)$/.test(callee));
  mark('lifecycle',/\.effect$/.test(callee)||/\.(?:start|stop|dispose)$/.test(callee));
  mark('dynamic-import',callee==='import'||language==='Python'&&callee==='__import__');
  return result;
}
export function ruleDocuments(language,kind) {
  const docs=[{id:'calls',language,rule:{kind}},{id:'parse-error',language,rule:{kind:'ERROR'}}];
  if(['JavaScript','TypeScript','Tsx'].includes(language)) {
    docs.push({id:'inject',language,rule:{pattern:'export const inject = $VALUE'}});
    docs.push({id:'tool-declaration',language,rule:{pattern:'defineTool($NAME, $DESCRIPTION, $$$REST)'}});
  }
  return docs.map(d=>JSON.stringify(d)).join('\n---\n');
}
