import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Project} from 'ts-morph';
import {walk,writeJson,packageInfo} from './io.mjs';
import {makeModel,Node,SyntaxKind,ts,callable,owner,nodeKey,member,declarations,provenanceStatus} from './morph-model.mjs';

export async function morphScan(sourceArg,outArg){
  const started=performance.now(),source=path.resolve(sourceArg),out=path.resolve(outArg);
  if(out===source||out.startsWith(source+path.sep)||fs.existsSync(path.join(out,'source-snapshot')))throw new Error('Use a fresh output directory outside source');
  fs.mkdirSync(out,{recursive:true});
  const snapshot=path.join(out,'source-snapshot'),files=walk(source);
  const inventory=files.map(file=>{
    const from=path.join(source,file),to=path.join(snapshot,file),bytes=fs.readFileSync(from);
    fs.mkdirSync(path.dirname(to),{recursive:true});fs.writeFileSync(to,bytes);
    return {file,bytes:bytes.length,analyzed:/\.(?:[cm]?js|jsx|tsx?)$/.test(file)};
  });
  const compilerOptions={allowJs:true,checkJs:true,noEmit:true,strict:false,types:[],target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,skipLibCheck:true,allowImportingTsExtensions:true};
  const project=new Project({useInMemoryFileSystem:true,skipAddingFilesFromTsConfig:true,skipFileDependencyResolution:true,compilerOptions});
  for(const f of inventory.filter(f=>f.analyzed))project.createSourceFile('/sample/'+f.file,fs.readFileSync(path.join(snapshot,f.file),'utf8'));
  const loadMs=performance.now()-started,model=makeModel(project),{loc}=model;
  const callableNodes=model.sourceFiles.flatMap(f=>f.getDescendants().filter(callable));
  const callableMap=new Map(callableNodes.map((n,i)=>[nodeKey(n),{id:`F${String(i+1).padStart(4,'0')}`,node:n}]));
  const functionId=n=>callableMap.get(nodeKey(n))?.id||null;
  const functions=callableNodes.map(n=>({id:functionId(n),kind:n.getKindName(),name:Node.isConstructorDeclaration(n)?'constructor':n.getName?.()||n.getParentIfKind(SyntaxKind.VariableDeclaration)?.getName()||`anonymous@${loc(n).startLine}`,location:loc(n)}));
  const a=[],wiring=[],edges=[],registrations=[],constructions=[],effects=[],unresolvedCalls=[];
  const traceCache=new Map();
  const trace=n=>{const key=nodeKey(n);if(!traceCache.has(key))traceCache.set(key,model.trace(n));return traceCache.get(key);};
  const bindingBase=access=>Node.isIdentifier(access?.base)&&declarations(access.base).some(d=>{
    if(!Node.isBindingElement(d)||!Node.isObjectBindingPattern(d.getParent()))return false;
    const variable=d.getParent().getParent(),init=Node.isVariableDeclaration(variable)?variable.getInitializer():null;
    return Node.isIdentifier(init)&&declarations(init).some(Node.isParameterDeclaration);
  });
  for(const call of model.calls){
    const expr=call.getExpression(),access=member(expr),fn=owner(call),from=functionId(fn);
    const literalMethod=access?.name;
    const aliasDecl=Node.isIdentifier(expr)?declarations(expr).filter(Node.isVariableDeclaration):[];
    const aliasCandidate=aliasDecl.some(d=>{const x=d.getInitializer();return x&&(member(x)||Node.isCallExpression(x)&&member(x.getExpression())?.name==='bind');});
    let targets=[];
    const direct=declarations(access?.keyNode||expr).flatMap(d=>callable(d)?[d]:Node.isVariableDeclaration(d)&&callable(d.getInitializer())?[d.getInitializer()]:[]);
    if(direct.length)targets=direct.map(node=>({kind:'definition',node,steps:[]}));
    const parameterReceiver=Node.isIdentifier(access?.base)&&declarations(access.base).some(Node.isParameterDeclaration);
    const inspect=['register','section','append','prepend','add','start','stop','watch','resolve','effect'].includes(literalMethod)||aliasCandidate||bindingBase(access)||parameterReceiver;
    if(inspect){const traced=trace(expr);if(traced.length)targets=traced;}
    const relevantAlias=aliasCandidate&&targets.some(t=>['register','section','append','prepend','add'].includes(t.path?.at(-1))||t.kind==='definition'&&['register','section'].includes(t.node.getName?.()));
    const status=provenanceStatus(targets);
    if(['register','section','append','prepend','add'].includes(literalMethod)||relevantAlias){
      const paths=targets.filter(r=>r.kind==='entry-parameter').map(r=>r.path.join('.'));
      const hostTool=paths.includes('tools.register'),hostPrompt=paths.some(p=>/^systemPrompt\.(section|append|prepend|add)$/.test(p));
      const local=targets.length&&targets.every(r=>r.kind==='definition');
      const ambiguous=(hostTool||hostPrompt)&&targets.some(r=>r.kind!=='entry-parameter'||r.conditional||r.multipleSources||r.incomplete);
      a.push({status,id:`M${String(a.length+1).padStart(3,'0')}`,location:loc(call),expression:expr.getText(),compiler:model.symbolInfo(access?.keyNode||expr),compilerCalleeType:model.typeInfo(expr),receiver:access?model.typeInfo(access.base):null,provenance:targets.map(model.serialize),assessment:!status.candidateSetComplete?'incomplete-provenance':ambiguous?'ambiguous-host-and-other-candidates':hostTool?'host-tool-path-candidate':hostPrompt?'host-prompt-path-candidate':local?'local-definition-not-host-proof':'unknown',confidence:!status.candidateSetComplete?'Incomplete candidate set; retained local/host targets cannot exclude omitted alternatives':hostTool||hostPrompt?'Host role follows exported-apply convention, not compiler type proof':local?'Resolved local definition; no host provenance in supported paths':'Unresolved; do not conclude absence'});
    }
    if(bindingBase(access)){
      const bases=declarations(access.base).filter(Node.isBindingElement);
      wiring.push({status,id:`W${String(wiring.length+1).padStart(3,'0')}`,use:loc(call),member:literalMethod,receiver:access.base.getText(),compilerReceiver:model.symbolInfo(access.base),compilerMember:model.symbolInfo(access.keyNode),binding:bases.map(loc),relations:targets.map(model.serialize),attribution:'Compiler symbol/type facts are separate from syntax-guided argument/destructure/factory relation candidates',calleeFunctions:targets.filter(r=>r.kind==='definition').map(r=>functionId(r.node)).filter(Boolean)});
    }
    for(const t of targets.filter(r=>r.kind==='definition'&&callable(r.node)))edges.push({from,to:functionId(t.node),call:loc(call),mechanism:t.steps.length?'syntax-guided-provenance':'compiler-symbol',conditional:t.conditional||false,status,provenance:model.serialize(t)});
    if(!targets.some(r=>r.kind==='definition'&&callable(r.node)))unresolvedCalls.push({from,call:loc(call),status,provenance:targets.map(model.serialize),reason:access?.name===null?'dynamic property':targets.find(t=>t.reason)?.reason||'no callable definition in current analysis program'});
    const hostPaths=targets.filter(t=>t.kind==='entry-parameter').map(t=>t.path.join('.'));
    if(literalMethod==='effect'||hostPaths.includes('effect')){
      const setup=call.getArguments()[0];
      if(callable(setup)){
        edges.push({from,to:functionId(setup),call:loc(call),mechanism:'effect-setup-contract-candidate',status,notExecutionProof:true});
        const returned=setup.getDescendantsOfKind(SyntaxKind.ReturnStatement).filter(r=>owner(r)===setup).map(r=>r.getExpression()).filter(callable);
        const cleanups=returned.map(n=>functionId(n));
        for(const n of returned)edges.push({from:functionId(setup),to:functionId(n),call:loc(n),mechanism:'returned-cleanup-candidate',status,notExecutionProof:true});
        effects.push({call:loc(call),parent:from,setup:functionId(setup),cleanup:cleanups,assumption:'effect setup/returned disposer interpretation is a lifecycle convention, not runtime proof'});
      }
    }
    if(hostPaths.includes('tools.register'))registrations.push({status,call:loc(call),from,role:'tool-registration',notExecutionProof:true});
    if(/^(?:ctx\.)?timer\.(?:interval|timeout)$/.test(expr.getText())||hostPaths.some(p=>/^timer\.(interval|timeout)$/.test(p))||['setInterval','setTimeout'].includes(expr.getText())){
      const callback=call.getArguments()[0];
      if(callable(callback))edges.push({from,to:functionId(callback),call:loc(call),mechanism:'scheduled-callback-candidate',status,notExecutionProof:true});
      effects.push({call:loc(call),parent:from,callback:functionId(callback),assignment:call.getFirstAncestor(Node.isBinaryExpression)?loc(call.getFirstAncestor(Node.isBinaryExpression)):null,assumption:'Scheduled callback syntax; no execution or cancellation proof'});
    }
  }
  for(const file of model.sourceFiles)for(const expression of file.getDescendantsOfKind(SyntaxKind.NewExpression)){
    const classes=declarations(expression.getExpression()).filter(Node.isClassDeclaration);
    for(const cls of classes)for(const ctor of cls.getConstructors()){
      constructions.push({call:loc(expression),constructor:functionId(ctor),classDefinition:loc(cls),from:functionId(owner(expression))});
      edges.push({from:functionId(owner(expression)),to:functionId(ctor),call:loc(expression),mechanism:'new-constructor'});
    }
  }
  // Register callback arguments are recorded as call-time entry candidates, not executed.
  const toolBodies=[];
  for(const call of model.calls){
    const argCallbacks=call.getArguments().filter(callable);
    if(!argCallbacks.length)continue;
    const declared=call.getArguments()[0];
    if(Node.isStringLiteral(declared)&&call.getArguments().length>=3){
      for(const callback of argCallbacks)toolBodies.push({name:declared.getLiteralText(),definitionCall:loc(call),body:functionId(callback),assumption:'String-first descriptor with callback; not universal tool API recognition'});
    }
  }
  const resources=[],identifierCalls=new Map(),variableWrites=new Map();
  for(const call of model.calls)if(Node.isIdentifier(call.getExpression()))for(const decl of declarations(call.getExpression())){
    const key=nodeKey(decl);if(!identifierCalls.has(key))identifierCalls.set(key,[]);identifierCalls.get(key).push(call);
  }
  for(const assignment of model.assignments)for(const decl of declarations(assignment.getLeft())){
    const key=nodeKey(decl);if(!variableWrites.has(key))variableWrites.set(key,[]);variableWrites.get(key).push(assignment);
  }
  for(const variable of model.sourceFiles.flatMap(f=>f.getDescendantsOfKind(SyntaxKind.VariableDeclaration))){
    if(!Node.isIdentifier(variable.getNameNode()))continue;
    const symbol=variable.getNameNode().getSymbol();if(!symbol)continue;
    const key=nodeKey(variable);
    const invocations=identifierCalls.get(key)||[];
    const writes=variableWrites.get(key)||[];
    const timerWrites=writes.filter(w=>Node.isCallExpression(w.getRight())&&/\.(interval|timeout)$/.test(w.getRight().getExpression().getText()));
    if(timerWrites.length&&invocations.length)resources.push({variable:loc(variable),symbol:model.symbolInfo(variable.getNameNode()),acquisition:timerWrites.map(loc),releaseInvocation:invocations.map(c=>({location:loc(c),function:functionId(owner(c)),optional:c.hasQuestionDotToken()})),resetAssignments:writes.filter(w=>w.getRight().getText()==='null').map(loc),conclusion:'Shared variable binds acquired timer result and later invocation; whether invocation cancels/awaits in-flight work remains unknown'});
  }
  const diagnostics=project.getPreEmitDiagnostics().map(diag=>({code:diag.getCode(),category:diag.getCategory(),file:diag.getSourceFile()?.getFilePath().replace('/sample/','')||null,start:diag.getStart(),message:ts.flattenDiagnosticMessageText(diag.compilerObject.messageText,'\n').slice(0,700)}));
  const syntaxErrors=project.getProgram().compilerObject.getSyntacticDiagnostics().map(diag=>({code:diag.code,file:diag.file?.fileName,message:ts.flattenDiagnosticMessageText(diag.messageText,'\n')}));
  const version=packageInfo('ts-morph').version;
  const limits=[...model.limitations,'Only supported literal properties, direct identifier call sites, assignments and factory return candidates are traversed. No complete control/data-flow or runtime call graph.', 'Assignments/returns are candidate alternatives; reachability and object mutation/monkey patching are not solved.', 'Any/unknown and missing host/node declarations remain explicit. No fabricated declarations added.','findReferences scope is current in-memory program, not runtime call completeness.'];
  for(const f of inventory)if(!fs.readFileSync(path.join(source,f.file)).equals(fs.readFileSync(path.join(snapshot,f.file))))throw new Error(`Input changed: ${f.file}`);
  const metadata={recordedAt:new Date().toISOString(),source,snapshot,version,rules:'morph-spike-2',typescript:ts.version,runtime:{execPath:process.execPath,node:process.version,electron:process.versions.electron||null},sourceFiles:inventory.filter(f=>f.analyzed).length,sourceBytes:inventory.filter(f=>f.analyzed).reduce((n,f)=>n+f.bytes,0),loadMs:Math.round(loadMs),elapsedMs:Math.round(performance.now()-started),compilerOptions,projectOptions:{useInMemoryFileSystem:true,skipAddingFilesFromTsConfig:true,skipFileDependencyResolution:true},supplementalDeclarations:[],entryHostAssumption:'Only exported apply parameter 0 is interpreted as host-role candidate by convention; no host type proof'};
  const mutations=model.assignments.filter(x=>!!member(x.getLeft())).map(x=>({location:loc(x),function:functionId(owner(x)),left:loc(x.getLeft()),right:loc(x.getRight()),meaning:'Assignment syntax only; alias identity, actual execution and data ownership are not proved'}));
  const result={metadata,methodOwnership:a,wiring,phases:{functions,edges,constructions,registrations,effects,toolBodies,resources,mutations,unresolvedCalls},diagnostics,syntaxErrors,unknowns:limits};
  writeJson(path.join(out,'inventory.json'),{files:inventory,source,snapshot,positionBinding:'Exact retained source bytes; no upstream commit claim'});
  writeJson(path.join(out,'analysis.json'),result);
  const items=[...a.map(x=>({id:x.id,kind:'method',file:x.location.file,line:x.location.startLine,assessment:x.assessment,detail:x})),...wiring.map(x=>({id:x.id,kind:'wiring',file:x.use.file,line:x.use.startLine,member:x.member,detail:x}))];
  for(const row of items)writeJson(path.join(out,'evidence',`${row.id}.json`),row.detail);
  writeJson(path.join(out,'reading-index.json'),{metadata,items:items.map(({detail,...r})=>({...r,path:`evidence/${r.id}.json`})),phases:'phase-index.json',unknowns:limits});
  writeJson(path.join(out,'phase-index.json'),{functions,edges,constructions,registrations,effects,toolBodies,resources,mutations,warning:'Static candidate relations, not actual lifecycle execution or successful release'});
  writeJson(path.join(out,'measurements.json'),{...metadata,analysisBytes:fs.statSync(path.join(out,'analysis.json')).size,indexBytes:fs.statSync(path.join(out,'reading-index.json')).size,phaseBytes:fs.statSync(path.join(out,'phase-index.json')).size,methodCandidates:a.length,wiringSites:wiring.length,diagnostics:diagnostics.length,syntaxErrors:syntaxErrors.length,tokenUsage:null});
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [source,out]=process.argv.slice(2);if(!source||!out)throw new Error('morph-scan.mjs SOURCE FRESH_OUT');
  const r=await morphScan(source,out);console.log(JSON.stringify({metadata:r.metadata,methods:r.methodOwnership.length,wiring:r.wiring.length,diagnostics:r.diagnostics.length,resources:r.phases.resources.length}));
}
