// A bounded, syntax-guided provenance experiment, not a general data-flow engine.
import { Node, SyntaxKind, ts } from 'ts-morph';
export { Node, SyntaxKind, ts };
export const callable=n=>!!n&&(Node.isFunctionDeclaration(n)||Node.isMethodDeclaration(n)||Node.isArrowFunction(n)||Node.isFunctionExpression(n)||Node.isConstructorDeclaration(n));
export const owner=n=>n.getFirstAncestor(callable);
// The single unwrapping path used before literal detection (v2 §2.1).
// Callers must still confirm StringLiteral / NoSubstitutionTemplateLiteral;
// unwrapping alone never turns an identifier or call into an action value.
export function unwrapExpression(node){
  let current=node;
  while(current&&(Node.isParenthesizedExpression(current)||Node.isAsExpression(current)||Node.isNonNullExpression(current)))current=current.getExpression();
  return current;
}
export function directTerminal(statement){
  if(!statement)return null;
  if(Node.isReturnStatement(statement))return {action:'return',node:statement};
  if(Node.isThrowStatement(statement))return {action:'throw',node:statement};
  if(Node.isBlock(statement)){
    const statements=statement.getStatements();
    return statements.length===1?directTerminal(statements[0]):null;
  }
  return null;
}
export const nodeKey=n=>n?`${n.getSourceFile().getFilePath()}:${n.getStart()}:${n.getEnd()}:${n.getKindName()}`:'none';
export function member(node) {
  if(Node.isPropertyAccessExpression(node))return {base:node.getExpression(),name:node.getName(),keyNode:node.getNameNode(),computed:false};
  if(Node.isElementAccessExpression(node)){
    const key=node.getArgumentExpression();
    return {base:node.getExpression(),name:Node.isStringLiteral(key)||Node.isNumericLiteral(key)?key.getLiteralText():null,keyNode:key,computed:true};
  }
  return null;
}
export function declarations(node) {
  let symbol=node?.getSymbol();
  if(symbol?.isAlias())symbol=symbol.getAliasedSymbol()||symbol;
  return symbol?.getDeclarations()||[];
}
export function inherit(target,...sources){
  const all=[...sources,target],unique=xs=>[...new Map(xs.map(x=>[JSON.stringify(x),x])).values()];
  return {...target,conditional:all.some(x=>x.conditional),multipleSources:all.some(x=>x.multipleSources),incomplete:all.some(x=>x.incomplete),
    uncertainty:unique(all.flatMap(x=>x.uncertainty||[])),truncations:unique(all.flatMap(x=>x.truncations||[])),
    assumptions:unique(all.flatMap(x=>[...(x.assumptions||[]),...(x.assumption?[x.assumption]:[])]))};
}
import {provenanceStatus} from './status.mjs';
export {provenanceStatus} from './status.mjs';
export function makeModel(project,root='/sample') {
  const sourceFiles=project.getSourceFiles().filter(f=>f.getFilePath().startsWith(root+'/'));
  const calls=sourceFiles.flatMap(f=>f.getDescendantsOfKind(SyntaxKind.CallExpression));
  const assignments=sourceFiles.flatMap(f=>f.getDescendantsOfKind(SyntaxKind.BinaryExpression)).filter(n=>n.getOperatorToken().getKind()===SyntaxKind.EqualsToken);
  const loc=n=>{
    const f=n.getSourceFile(),start=n.getStart(),end=n.getEnd(),a=f.getLineAndColumnAtPos(start),b=f.getLineAndColumnAtPos(end);
    return {file:f.getFilePath().slice(root.length+1),start,end,startLine:a.line,startColumn:a.column,endLine:b.line,endColumn:b.column,positionUnit:'UTF-16 code units in retained source',snippet:n.getText().slice(0,500),snippetTruncated:n.getWidth()>500};
  };
  const incoming=new Map();
  for(const call of calls){
    const expr=call.getExpression();
    if(!Node.isIdentifier(expr))continue;
    for(const d of declarations(expr).filter(callable)){
      if(!incoming.has(nodeKey(d)))incoming.set(nodeKey(d),[]);
      incoming.get(nodeKey(d)).push(call);
    }
  }
  const limitations=new Set();
  const step=(kind,node,extra={})=>({kind,location:loc(node),...extra});
  const append=(results,kind,node,extra={})=>results.map(r=>({...r,steps:[step(kind,node,extra),...(r.steps||[])]}));
  const terminal=(kind,node,extra={})=>[{kind,node,steps:[],...extra}];
  const mark=(results,kind,node,extra={})=>results.map(r=>inherit(r,{conditional:true,multipleSources:results.length>1,uncertainty:[{kind,location:loc(node),notControlFlowProof:true,...extra}]}));
  const cap=(results,limit,node,kind)=>{
    if(results.length<=limit)return results;
    const truncation={kind,location:loc(node),limit,retained:limit,total:null,observedAtLeast:results.length};
    limitations.add(`${kind} truncated; retained ${limit}; see per-result truncations`);
    return results.slice(0,limit).map(r=>inherit(r,{incomplete:true,truncations:[truncation]}));
  };
  function trace(expr,seen=new Set(),depth=0) {
    if(!expr)return [];
    if(depth>18){limitations.add('Provenance depth 18 reached; path remains unknown');return terminal('unknown',expr,{reason:'depth-limit',incomplete:true,truncations:[{kind:'depth',location:loc(expr),limit:18,retained:null,total:null}]});}
    const key=nodeKey(expr);
    if(seen.has(key))return terminal('unknown',expr,{reason:'recursive-provenance'});
    const next=new Set(seen);next.add(key);
    const recur=n=>trace(n,next,depth+1);
    if(Node.isParenthesizedExpression(expr)||Node.isAsExpression(expr)||Node.isNonNullExpression(expr))return recur(expr.getExpression());
    if(Node.isIdentifier(expr)){
      const defs=declarations(expr);
      if(!defs.length)return terminal('unknown',expr,{reason:'unresolved-symbol'});
      return defs.flatMap(d=>{
        if(Node.isVariableDeclaration(d)){
          const writes=assignments.filter(a=>declarations(a.getLeft()).some(x=>nodeKey(x)===nodeKey(d)));
          if(d.getInitializer()){
            const initial=append(recur(d.getInitializer()),'variable-initializer',d);
            if(writes.length)return mark([...initial,...writes.flatMap(a=>append(recur(a.getRight()),'assignment-candidate',a,{notControlFlowProof:true}))],'reassignment-alternatives',d);
            return initial;
          }
          if(writes.length)return mark(writes.flatMap(a=>append(recur(a.getRight()),'assignment-candidate',a,{notControlFlowProof:true})),'assignment-alternatives',d);
          return terminal('unknown',d,{reason:'uninitialized-variable'});
        }
        if(Node.isBindingElement(d)){
          const binding=d.getParent().getParent();
          const source=Node.isVariableDeclaration(binding)?binding.getInitializer():Node.isParameterDeclaration(binding)?binding:null;
          const key=d.getPropertyNameNode()?.getText().replace(/^['"]|['"]$/g,'')||d.getName();
          return append(select(recur(source),key,next,depth+1),'object-destructure',d,{property:key});
        }
        if(Node.isParameterDeclaration(d)){
          if(assignments.some(a=>declarations(a.getLeft()).some(x=>nodeKey(x)===nodeKey(d))))return terminal('unknown',d,{reason:'parameter reassignment not modeled'});
          const fn=owner(d),index=fn?.getParameters().indexOf(d),sites=incoming.get(nodeKey(fn))||[];
          if(sites.length){
            if(sites.length>12)limitations.add('Only first 12 direct incoming calls traced; not a complete call graph');
            let result=sites.slice(0,12).flatMap(call=>{
              const actual=call.getArguments()[index]||d.getInitializer();
              return append(recur(actual),'argument-to-parameter',call,{parameter:loc(d),parameterIndex:index,actual:actual?loc(actual):null});
            });
            if(sites.length>1)result=mark(result,'multiple-incoming-calls',d,{observedCallSites:sites.length});
            if(sites.length>12)result=result.map(r=>inherit(r,{incomplete:true,truncations:[{kind:'incoming-calls',location:loc(d),limit:12,retained:12,total:sites.length}]}));
            return result;
          }
          if(fn&&Node.isFunctionDeclaration(fn)&&fn.isExported()&&fn.getName()==='apply'&&index===0)return terminal('entry-parameter',d,{path:[],assumption:'Convention: exported apply parameter 0 is host context. No host declaration added; actual type may be any.'});
          return terminal('parameter',d,{path:[],reason:'No direct incoming identifier call resolved in current program'});
        }
        if(Node.isShorthandPropertyAssignment(d))return append(traceSymbolValue(d,next,depth+1),'object-shorthand',d);
        if(callable(d)||Node.isClassDeclaration(d))return terminal('definition',d);
        if(Node.isPropertyAssignment(d))return recur(d.getInitializer());
        return terminal('unknown',d,{reason:`unsupported declaration ${d.getKindName()}`});
      });
    }
    if(callable(expr))return terminal('definition',expr);
    if(Node.isObjectLiteralExpression(expr))return terminal('local-object',expr);
    if(expr.getKind()===SyntaxKind.ThisKeyword){
      const cls=expr.getFirstAncestor(Node.isClassDeclaration);
      return cls?terminal('class-instance',cls):terminal('unknown',expr,{reason:'this outside supported class context'});
    }
    if(Node.isNewExpression(expr)){
      return declarations(expr.getExpression()).filter(Node.isClassDeclaration).flatMap(cls=>terminal('class-instance',cls,{steps:[step('new-instance',expr)],createdAt:loc(expr)}));
    }
    const access=member(expr);
    if(access){
      if(access.name===null)return terminal('unknown',expr,{reason:'non-literal-computed-property'});
      return append(select(recur(access.base),access.name,next,depth+1),'property-access',expr,{property:access.name,computedLiteral:access.computed});
    }
    if(Node.isCallExpression(expr)){
      const access=member(expr.getExpression());
      if(access?.name==='bind')return append(recur(access.base),'bind-alias',expr,{thisArgument:expr.getArguments()[0]?loc(expr.getArguments()[0]):null,warning:'Syntactic bind relation; no runtime monkey-patch verification'});
      const sources=recur(expr.getExpression()),targets=sources.filter(r=>r.kind==='definition'&&callable(r.node));
      let values=sources.filter(r=>!targets.includes(r)).map(r=>inherit({kind:'unknown',node:expr,reason:'unresolved factory callee',steps:r.steps||[]},r));
      outer:for(const r of targets){
        const returns=r.node.getDescendantsOfKind(SyntaxKind.ReturnStatement).filter(s=>owner(s)===r.node&&s.getExpression());
        if(!returns.length)values.push(inherit({kind:'unknown',node:expr,reason:'factory has no explicit supported return',steps:[]},r));
        for(const s of returns){
          let candidates=append(recur(s.getExpression()),'factory-return-candidate',expr,{factory:loc(r.node),returnSite:loc(s)}).map(t=>inherit({...t,steps:[...(r.steps||[]),...t.steps]},r));
          const syntacticCondition=s.getAncestors().some(n=>n!==r.node&&[SyntaxKind.IfStatement,SyntaxKind.SwitchStatement,SyntaxKind.CaseClause,SyntaxKind.WhileStatement,SyntaxKind.ForStatement,SyntaxKind.TryStatement].includes(n.getKind())&&n.getStart()>=r.node.getStart()&&n.getEnd()<=r.node.getEnd());
          if(returns.length>1||syntacticCondition)candidates=mark(candidates,'return-alternatives-or-condition',s,{returnStatementsObserved:returns.length});
          values.push(...candidates);
          if(values.length>24)break outer;
        }
      }
      if(sources.length>1)values=mark(values,'factory-target-alternatives',expr);
      return cap(values.length?values:terminal('unknown',expr,{reason:'no supported factory targets'}),24,expr,'factory-return-candidates');
    }
    if(Node.isConditionalExpression(expr))return mark([...recur(expr.getWhenTrue()),...recur(expr.getWhenFalse())],'conditional-expression',expr);
    return terminal('unknown',expr,{reason:`unsupported expression ${expr.getKindName()}`});
  }
  function traceSymbolValue(shorthand,seen,depth){
    const sym=shorthand.getValueSymbol();
    const decls=sym?.getDeclarations()||[];
    return decls.flatMap(d=>Node.isVariableDeclaration(d)?trace(d.getNameNode(),seen,depth+1):callable(d)?terminal('definition',d):[]);
  }
  function select(results,name,seen,depth){
    return results.flatMap(r=>{
      if(r.kind==='entry-parameter'||r.kind==='parameter')return [{...r,path:[...r.path,name]}];
      const object=r.node;
      let prop;
      if(r.kind==='local-object')prop=object.getProperties().find(p=>p.getName?.()===name||p.getNameNode?.()?.getText()===`'${name}'`);
      if(r.kind==='class-instance')prop=object.getInstanceMembers().find(p=>p.getName?.()===name);
      if(!prop)return [{...r,kind:'unknown',reason:`property ${name} not resolved on ${r.kind}`,path:[...(r.path||[]),name]}];
      let targets=[];
      if(callable(prop))targets=terminal('definition',prop);
      else if(Node.isPropertyAssignment(prop)||Node.isPropertyDeclaration(prop))targets=trace(prop.getInitializer(),seen,depth+1);
      else if(Node.isShorthandPropertyAssignment(prop))targets=traceSymbolValue(prop,seen,depth+1);
      else targets=terminal('unknown',prop,{reason:'unsupported member declaration'});
      if(!targets.length)targets=terminal('unknown',prop,{reason:'empty or unresolved member value'});
      return targets.map(t=>inherit({...t,steps:[...(r.steps||[]),step('member-definition',prop,{property:name}),...(t.steps||[])]},r));
    });
  }
  const serialize=r=>({kind:r.kind,definition:loc(r.node),path:r.path||[],reason:r.reason||null,assumption:r.assumption||null,assumptions:r.assumptions||[],conditional:!!r.conditional,multipleSources:!!r.multipleSources,incomplete:!!r.incomplete,uncertainty:r.uncertainty||[],truncations:r.truncations||[],steps:r.steps||[]});
  const typeInfo=node=>{
    const t=node.getType();return {text:t.getText(node).slice(0,240),any:t.isAny(),unknown:t.isUnknown(),union:t.isUnion()?t.getUnionTypes().map(x=>x.getText(node).slice(0,100)):[],symbolDeclarations:declarations(node).map(loc)};
  };
  const symbolCache=new Map();
  const symbolInfo=node=>{
    const symbol=node.getSymbol(),defs=declarations(node);
    const cacheKey=defs.length?defs.map(nodeKey).join('|'):nodeKey(node);
    if(symbolCache.has(cacheKey))return symbolCache.get(cacheKey);
    const identifier=Node.isIdentifier(node)?node:defs.find(d=>Node.isIdentifier(d.getNameNode?.()))?.getNameNode();
    let refs=[];
    if(identifier?.findReferencesAsNodes)refs=identifier.findReferencesAsNodes().filter(n=>n.getSourceFile().getFilePath().startsWith(root+'/'));
    const result={name:symbol?.getName()||null,declarations:defs.map(loc),type:typeInfo(node),referenceScope:'References found only in this in-memory analysis program under these compiler options, not all runtime calls',referenceCount:refs.length,references:refs.slice(0,30).map(loc),referencesTruncated:refs.length>30};
    symbolCache.set(cacheKey,result);return result;
  };
  return {sourceFiles,calls,assignments,loc,trace,serialize,typeInfo,symbolInfo,incoming,limitations};
}
