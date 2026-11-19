import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {Project} from 'ts-morph';
import {walk,writeJson,packageInfo} from './io.mjs';
import {makeModel,Node,SyntaxKind,ts,callable,owner,nodeKey,member,declarations,provenanceStatus,unwrapExpression,directTerminal} from './morph-model.mjs';
import {classifyEntrySyntax} from './rules.mjs';

const ENTRY_GAPS = Object.freeze([
  'arbitrary-control-flow-solving', 'dynamic-property-access', 'multi-source-assignment-joins',
  'cross-function-data-flow', 'nested-early-exit-attribution', 'runtime-permission-or-write-proof'
]);
const ENTRY_CONTROL_KINDS = new Set([
  SyntaxKind.IfStatement, SyntaxKind.SwitchStatement, SyntaxKind.ForStatement, SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement, SyntaxKind.WhileStatement, SyntaxKind.DoStatement, SyntaxKind.TryStatement,
  SyntaxKind.WithStatement
]);
const ENTRY_EQUALITY_KINDS = new Set([
  SyntaxKind.EqualsEqualsToken, SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken, SyntaxKind.ExclamationEqualsEqualsToken
]);
const dedupeBy = (values, key) => [...new Map(values.map(value => [key(value), value])).values()];
const dedupeJson = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
function boundedString(text, max = 240) {
  const source = String(text || '');
  return { text: source.slice(0, max), truncated: source.length > max };
}
function isNegatedOperand(node) {
  const unwrapped = unwrapExpression(node);
  return Node.isIdentifier(unwrapped) || !!member(unwrapped);
}
function isNegatedExpression(node) {
  const unwrapped = unwrapExpression(node), operator = unwrapped.getOperatorToken?.();
  const operatorKind = typeof operator === 'number' ? operator : operator?.getKind?.();
  return Node.isPrefixUnaryExpression(unwrapped)
    && operatorKind === SyntaxKind.ExclamationToken
    && isNegatedOperand(unwrapped.getOperand());
}
function permissionShape(node) {
  const unwrapped = unwrapExpression(node);
  if (isNegatedExpression(unwrapped)) return 'single';
  if (Node.isBinaryExpression(unwrapped) && unwrapped.getOperatorToken().getKind() === SyntaxKind.BarBarToken) {
    const stack = [unwrapped.getLeft(), unwrapped.getRight()], parts = [];
    while (stack.length) {
      const part = unwrapExpression(stack.pop());
      if (Node.isBinaryExpression(part) && part.getOperatorToken().getKind() === SyntaxKind.BarBarToken) {
        stack.push(part.getLeft(), part.getRight());
        continue;
      }
      if (!isNegatedExpression(part)) return null;
      parts.push(part);
    }
    return parts.length > 1 ? 'union' : null;
  }
  return null;
}
function hasDynamicProperty(node) {
  if (!node) return false;
  return [node, ...(node.getDescendants?.() || [])].some(candidate => {
    if (!Node.isElementAccessExpression(candidate)) return false;
    const key = candidate.getArgumentExpression();
    return !(Node.isStringLiteral(key) || Node.isNumericLiteral(key));
  });
}
export function extractEntryConditions(model, callableNodes, functionId, phases = {}) {
  const { loc } = model;
  const traceCache = new Map();
  // Comparison subject nodes are kept out of the serialized facts; this side map
  // exists only for same-symbol reassignment checks inside a callable.
  const factSubjects = new WeakMap();
  const trace = node => {
    const key = nodeKey(node);
    if (!traceCache.has(key)) traceCache.set(key, model.trace(node));
    return traceCache.get(key);
  };
  const directIfs = fn => fn.getDescendantsOfKind(SyntaxKind.IfStatement).filter(stmt => {
    if (owner(stmt) !== fn) return false;
    return !stmt.getAncestors().some(ancestor =>
      ancestor !== fn && ancestor.getStart() >= fn.getStart() && ancestor.getEnd() <= fn.getEnd()
      && ENTRY_CONTROL_KINDS.has(ancestor.getKind()));
  });

  // v2 §2.1: the single action-literal entry. Only AST-confirmed string literals and
  // no-substitution template literals (after unwrapExpression) may become action values.
  const literalValue = node => {
    if (!node) return null;
    const unwrapped = unwrapExpression(node);
    let form = null;
    if (Node.isStringLiteral(unwrapped)) form = 'string-literal';
    else if (Node.isNoSubstitutionTemplateLiteral(unwrapped)) form = 'no-substitution-template';
    else return null;
    const value = unwrapped.getLiteralText?.();
    if (typeof value !== 'string') return null;
    return { value, form, raw: unwrapped.getText(), location: loc(unwrapped) };
  };
  const literalActionsFrom = node => {
    if (!node) return [];
    const values = [node, ...(node.getDescendants?.() || [])]
      .map(candidate => literalValue(candidate))
      .filter(value => value && value.value.length <= 200)
      .map(value => value.value);
    return [...new Set(values)];
  };
  const subjectOf = node => {
    const unwrapped = unwrapExpression(node);
    let kind = 'other';
    if (Node.isIdentifier(unwrapped)) kind = 'identifier';
    else if (member(unwrapped)) kind = 'member';
    else if (Node.isCallExpression(unwrapped)) kind = 'call';
    else if (Node.isTemplateExpression(unwrapped)) kind = 'interpolated-template';
    else if (Node.isStringLiteral(unwrapped) || Node.isNoSubstitutionTemplateLiteral(unwrapped)) kind = 'literal';
    return { text: unwrapped.getText(), kind, location: loc(unwrapped) };
  };
  const operatorText = kind => ({
    [SyntaxKind.EqualsEqualsToken]: '==',
    [SyntaxKind.EqualsEqualsEqualsToken]: '===',
    [SyntaxKind.ExclamationEqualsToken]: '!=',
    [SyntaxKind.ExclamationEqualsEqualsToken]: '!=='
  })[kind] || null;
  const isEqualsOperator = operator => operator === '==' || operator === '===';

  // v2 §2.2: one comparison fact per equality/inequality binary, with the fixed polarity table.
  const equalityFacts = (condition, seq) => {
    if (!condition) return [];
    const binaries = [condition, ...(condition.getDescendantsOfKind?.(SyntaxKind.BinaryExpression) || [])]
      .filter(candidate => Node.isBinaryExpression(candidate) && ENTRY_EQUALITY_KINDS.has(candidate.getOperatorToken().getKind()));
    const facts = [];
    for (const binary of binaries) {
      const operator = operatorText(binary.getOperatorToken().getKind());
      const left = binary.getLeft(), right = binary.getRight();
      const leftLit = literalValue(left), rightLit = literalValue(right);
      const literalInfo = leftLit ? { ...leftLit, side: 'left' } : rightLit ? { ...rightLit, side: 'right' } : null;
      const subjectNode = leftLit ? right : left;
      const subject = subjectOf(subjectNode);
      const hasInterpolated = [left, right].some(side => Node.isTemplateExpression(unwrapExpression(side)));
      const dynamicMember = (node => {
        const u = unwrapExpression(node), m = member(u);
        return !!m && m.computed && m.name === null;
      })(subjectNode);
      let status = 'supported', equalsLiteral;
      if (hasInterpolated || subject.kind === 'call' || dynamicMember) {
        status = 'unsupported-form'; equalsLiteral = { then: null, else: null };
      } else if (leftLit && rightLit && leftLit.value !== rightLit.value) {
        status = 'ambiguous-two-literals'; equalsLiteral = { then: null, else: null };
      } else if (!literalInfo) {
        status = 'no-literal'; equalsLiteral = { then: null, else: null };
      } else {
        equalsLiteral = isEqualsOperator(operator)
          ? { then: true, else: false }
          : { then: false, else: true };
      }
      facts.push({
        id: 'Q' + (++seq.q),
        operator,
        literal: literalInfo ? { value: literalInfo.value, form: literalInfo.form, raw: literalInfo.raw, side: literalInfo.side, location: literalInfo.location } : null,
        subject,
        coordinate: loc(binary),
        equalsLiteral,
        status
      });
      factSubjects.set(facts[facts.length - 1], subjectNode);
    }
    return facts;
  };
  const conditionShapeSupported = condition => {
    if (!condition) return false;
    for (const node of [condition, ...(condition.getDescendants?.() || [])]) {
      if (callable(node)) continue;
      const unwrapped = unwrapExpression(node);
      if (Node.isPrefixUnaryExpression(unwrapped)) return false;
      if (Node.isBinaryExpression(unwrapped)) {
        const kind = unwrapped.getOperatorToken().getKind();
        if (kind === SyntaxKind.AmpersandAmpersandToken || kind === SyntaxKind.BarBarToken) return false;
      }
      if (Node.isConditionalExpression(unwrapped)) return false;
    }
    return true;
  };
  const expressionKindOf = expression => {
    if (!expression) return { hasCall: false, isLiteral: false, kind: 'other' };
    const unwrapped = unwrapExpression(expression);
    const hasCall = [expression, ...(expression.getDescendants?.() || [])].some(node => Node.isCallExpression(node));
    const isLiteral = !!literalValue(unwrapped);
    let kind = 'other';
    if (Node.isCallExpression(unwrapped) || hasCall && !isLiteral) kind = 'call';
    else if (isLiteral) kind = 'literal';
    return { hasCall, isLiteral, kind };
  };
  const guardsFor = (fn, details) => directIfs(fn).map(stmt => {
    const detail = details.get(nodeKey(stmt));
    const condition = stmt.getExpression(), thenNode = stmt.getThenStatement(), elseNode = stmt.getElseStatement();
    const thenExit = directTerminal(thenNode), elseExit = directTerminal(elseNode);
    const exits = [thenExit && { ...thenExit, branch: 'then' }, elseExit && { ...elseExit, branch: 'else' }].filter(Boolean);
    if (!exits.length) return null;
    const successBranches = [thenNode && !thenExit ? thenNode : null, elseNode && !elseExit ? elseNode : null].filter(Boolean);
    return { stmt, condition, exits, successBranches, shape: permissionShape(condition),
      classes: classifyEntrySyntax(condition.getText()),
      comparisons: detail ? detail.comparisons : [],
      conditionSupported: detail ? detail.conditionSupported : false };
  }).filter(Boolean);
  const earlyExitLiterals = guards => {
    const values = new Set();
    for (const guard of guards) for (const exit of guard.exits)
      for (const value of literalActionsFrom(exit.node.getExpression())) values.add(value);
    return values;
  };
  const exitPolarity = (guard, branch) => {
    const supported = guard.comparisons.filter(c => c.status === 'supported');
    if (!guard.conditionSupported || supported.length !== 1) return 'unknown';
    const fact = supported[0];
    const equalsPath = isEqualsOperator(fact.operator) ? 'then' : 'else';
    return branch === equalsPath ? 'equals-literal' : 'not-equals-literal';
  };
  const hasSideEffectSyntax = (branch, fn) => [branch, ...(branch?.getDescendants?.() || [])].some(node =>
    owner(node) === fn && (Node.isCallExpression(node)
      || Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken && !!member(node.getLeft())));
  const isUnconditionalTerminal = statement => Node.isReturnStatement(statement) || Node.isThrowStatement(statement);
  const sideEffectNodesIn = (statement, fn) => [statement, ...(statement?.getDescendants?.() || [])].filter(node =>
    owner(node) === fn && (Node.isCallExpression(node)
      || Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken && !!member(node.getLeft())));
  // Bounded statement-order scan. Only an explicit return/throw at the branch's own
  // statement level stops the scan; the terminating statement is scanned first so
  // `return sink()` still yields its call fact. Nested control flow stays unknown.
  const orderedBranchEffects = (branch, fn) => {
    if (!branch) return { nodes: [], truncated: false, complex: false, terminalEffects: false };
    const statements = Node.isBlock(branch) ? branch.getStatements() : [branch];
    const nodes = [];
    let complex = false, terminalEffects = false, stopAt = -1;
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index];
      const found = sideEffectNodesIn(statement, fn);
      nodes.push(...found);
      if (ENTRY_CONTROL_KINDS.has(statement.getKind())) complex = true;
      if (isUnconditionalTerminal(statement)) {
        terminalEffects = found.length > 0;
        stopAt = index;
        break;
      }
    }
    return { nodes: dedupeBy(nodes, nodeKey), truncated: stopAt >= 0 && stopAt < statements.length - 1,
      complex, terminalEffects };
  };
  const sameDeclaredSymbol = (left, right) => {
    const rightDeclarations = declarations(right);
    if (!rightDeclarations.length) return false;
    const rightKeys = new Set(rightDeclarations.map(nodeKey));
    return declarations(left).some(declaration => rightKeys.has(nodeKey(declaration)));
  };
  // Explicit `subject = ...` in the same callable before the comparison coordinate.
  // Symbol declarations (with symbolInfo as the identity source) prevent same-name
  // unrelated variables from being treated as a reassignment. No value-flow solving.
  const reassignmentBefore = (fact, fn) => {
    const subject = unwrapExpression(factSubjects.get(fact));
    if (!subject || !Node.isIdentifier(subject)) return null;
    const info = model.symbolInfo(subject);
    if (!info.name) return null;
    const file = subject.getSourceFile().getFilePath();
    for (const assignment of model.assignments) {
      if (owner(assignment) !== fn || assignment.getSourceFile().getFilePath() !== file) continue;
      if (assignment.getStart() >= fact.coordinate.start) continue;
      const left = unwrapExpression(assignment.getLeft());
      if (!Node.isIdentifier(left) || left.getText() !== info.name) continue;
      if (sameDeclaredSymbol(left, subject)) return assignment;
    }
    return null;
  };
  const branchShape = branch => {
    if (!branch) return 'absent';
    if (directTerminal(branch)) return 'terminal';
    if (Node.isIfStatement(branch)) return 'else-if';
    if (Node.isBlock(branch) && branch.getStatements().some(stmt => Node.isIfStatement(stmt) || ENTRY_CONTROL_KINDS.has(stmt.getKind()))) return 'nested-control';
    if (Node.isBlock(branch) && branch.getStatements().length > 1) return 'compound';
    return 'regular';
  };
  const nodesInBranch = (branch, fn) => {
    if (!branch) return [];
    return dedupeBy([branch, ...branch.getDescendants()].filter(node => node === branch || owner(node) === fn), nodeKey);
  };
  const conditionNodes = node => [node, ...(node?.getDescendants?.() || [])];
  const calledFunctionIds = call => {
    const expr = call.getExpression(), access = member(expr), ids = [];
    for (const declaration of declarations(access?.keyNode || expr)) {
      const target = callable(declaration) ? declaration
        : Node.isVariableDeclaration(declaration) && callable(declaration.getInitializer()) ? declaration.getInitializer() : null;
      const id = target && functionId(target);
      if (id) ids.push(id);
    }
    for (const argument of call.getArguments()) for (const target of callableTargets(argument)) {
      const id = functionId(target);
      if (id) ids.push(id);
    }
    return [...new Set(ids)];
  };
  const callableTargets = node => dedupeBy([
    ...(callable(node) ? [node] : []),
    ...declarations(node).flatMap(declaration => callable(declaration) ? [declaration]
      : Node.isVariableDeclaration(declaration) && callable(declaration.getInitializer()) ? [declaration.getInitializer()] : [])
  ], nodeKey);
  const at = node => { const l = loc(node); return `${l.file}:${l.startLine}:${l.startColumn}`; };

  // Two passes: first enumerate local (same-function / traceable-call) candidates, then
  // add unpaired cross-function clues only where no call edge or provenance exists.
  const prep = new Map();
  for (const fn of callableNodes) {
    const fnId = functionId(fn);
    if (!fnId) continue;
    const seq = { q: 0 }, details = new Map();
    for (const stmt of directIfs(fn)) {
      const condition = stmt.getExpression();
      details.set(nodeKey(stmt), { stmt, condition,
        comparisons: equalityFacts(condition, seq),
        conditionSupported: conditionShapeSupported(condition) });
    }
    const guards = guardsFor(fn, details);
    const denied = earlyExitLiterals(guards);
    const candidateDrafts = [];
    let ac = 0;
    for (const detail of details.values()) {
      for (const fact of detail.comparisons) {
        if (fact.status !== 'supported' || !fact.literal) continue;
        const value = fact.literal.value;
        if (denied.has(value)) continue;
        const equalsPath = isEqualsOperator(fact.operator) ? 'then' : 'else';
        const branch = equalsPath === 'then' ? detail.stmt.getThenStatement() : detail.stmt.getElseStatement();
        if (!branch) continue;
        const effects = orderedBranchEffects(branch, fn);
        const sideEffects = effects.nodes;
        if (!sideEffects.length) continue;
        const reassignment = reassignmentBefore(fact, fn);
        const draftStatus = detail.conditionSupported && !effects.complex && !reassignment ? 'candidate' : 'unknown';
        const sequenceGap = effects.complex
          ? [{ kind: 'branch-control-sequence-unsupported', notRuntimeProof: true }] : [];
        const reassignmentGap = reassignment
          ? [{ kind: 'subject-reassignment-value-flow', notRuntimeProof: true,
              subject: fact.subject.text, location: loc(reassignment) }] : [];
        const literalLoc = fact.literal.location;
        const basis = [
          `same-function condition ${at(detail.condition)}`,
          `${fact.literal.form} literal at ${literalLoc.file}:${literalLoc.startLine}:${literalLoc.startColumn}`
        ];
        for (const node of sideEffects.slice(0, 4)) basis.push(`side-effect syntax at ${at(node)}`);
        candidateDrafts.push({
          candidate: {
            id: 'AC' + (++ac), action: value,
            target: { functionId: fnId, entryLocation: loc(fn), location: literalLoc },
            condition: { operator: fact.operator, literalSide: fact.literal.side, subjectText: fact.subject.text,
              path: equalsPath, coordinate: loc(detail.condition) },
            basis,
            relation: 'same-function',
            uncertainty: [
              { kind: 'syntax-only-action-candidate', notRuntimeProof: true },
              ...(detail.conditionSupported ? [] : [{ kind: 'compound-or-negated-condition-polarity-unsupported' }]),
              ...sequenceGap, ...reassignmentGap
            ],
            status: draftStatus
          },
          fact, detail, equalsPath
        });
        for (const call of sideEffects.filter(Node.isCallExpression)) for (const targetId of calledFunctionIds(call)) {
          if (!targetId || targetId === fnId) continue;
          candidateDrafts.push({
            candidate: {
              id: 'AC' + (++ac), action: value,
              target: { functionId: targetId, entryLocation: loc(fn), location: literalLoc },
              condition: { operator: fact.operator, literalSide: fact.literal.side, subjectText: fact.subject.text,
                path: equalsPath, coordinate: loc(detail.condition) },
              basis: [...basis, `call edge at ${at(call)} to ${targetId}`],
              relation: 'traceable-call',
              uncertainty: [{ kind: 'syntax-only-action-candidate', notRuntimeProof: true },
                { kind: 'cross-function-value-flow-unproven' }, ...sequenceGap, ...reassignmentGap],
              status: draftStatus
            },
            fact, detail, equalsPath
          });
        }
      }
    }
    prep.set(fnId, { fn, fnId, guards, details,
      comparisons: [...details.values()].flatMap(d => d.comparisons),
      denied, candidateDrafts,
      localActions: new Set(candidateDrafts.filter(d => d.candidate.relation === 'same-function'
        && d.candidate.status === 'candidate').map(d => d.candidate.action)) });
  }
  for (const [fnId, info] of prep) {
    for (const detail of info.details.values()) for (const fact of detail.comparisons) {
      if (fact.status !== 'supported' || !fact.literal) continue;
      const value = fact.literal.value;
      if (info.denied.has(value) || info.localActions.has(value)) continue;
      const equalsPath = isEqualsOperator(fact.operator) ? 'then' : 'else';
      const callsInConditions = [...info.details.values()].flatMap(d =>
        conditionNodes(d.condition).filter(Node.isCallExpression));
      for (const [otherId, other] of prep) {
        if (otherId === fnId || !other.localActions.has(value)) continue;
        if (callsInConditions.some(call => calledFunctionIds(call).includes(otherId))) continue;
        const ll = fact.literal.location;
        info.candidateDrafts.push({
          candidate: {
            id: 'AC' + (info.candidateDrafts.length + 1), action: value,
            target: { functionId: otherId, entryLocation: loc(other.fn), location: ll },
            condition: { operator: fact.operator, literalSide: fact.literal.side, subjectText: fact.subject.text,
              path: equalsPath, coordinate: loc(detail.condition) },
            basis: [`same action literal ${value} observed in ${otherId}; no call edge or provenance`],
            relation: 'unpaired-clue',
            uncertainty: [{ kind: 'unpaired-cross-function-clue', noCallEdge: true, notRuntimeProof: true }],
            status: 'unknown'
          },
          fact, detail, equalsPath
        });
        break;
      }
    }
  }

  const records = [];
  for (const fn of callableNodes) {
    const fnId = functionId(fn);
    if (!fnId) continue;
    const info = prep.get(fnId), guards = info.guards;
    const localAcceptance = info.localActions.size > 0;
    let declaredDescription = null;
    const localTruncations = [], extracted = new Set(['callable-scope']), gaps = new Set(ENTRY_GAPS);
    for (const call of model.calls) {
      if (!call.getArguments().some(argument => callableTargets(argument).some(target => functionId(target) === fnId))) continue;
      const literals = call.getArguments()
        .filter(argument => Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))
        .map(argument => literalValue(argument)?.value).filter(value => typeof value === 'string' && value.trim().length >= 16)
        .sort((left, right) => right.length - left.length);
      if (!literals.length) continue;
      const bounded = boundedString(literals[0], 500);
      declaredDescription = bounded.text;
      if (bounded.truncated) localTruncations.push({ kind: 'declared-description', location: loc(call),
        limit: 500, retained: 500, total: literals[0].length });
      extracted.add('author-declared-literal');
      break;
    }
    const earlyExits = [], exitNodes = [];
    for (const guard of guards) {
      extracted.add('direct-if-early-exit');
      for (const exit of guard.exits) {
        exitNodes.push(exit.node);
        const expression = exit.node.getExpression();
        earlyExits.push({ action: exit.action, expression: expression?.getText() || '',
          location: loc(exit.node), literalActions: literalActionsFrom(expression),
          expressionKind: expressionKindOf(expression),
          owningCondition: loc(guard.condition), branch: exit.branch,
          polarity: exitPolarity(guard, exit.branch) });
        extracted.add(exit.action === 'return' ? 'direct-if-return' : 'direct-if-throw');
        const classes = classifyEntrySyntax(exit.node.getText());
        if (classes.includes('early-terminal')) extracted.add('early-terminal');
      }
      for (const branch of [guard.stmt.getThenStatement(), guard.stmt.getElseStatement()]) {
        if (!branch) continue;
        extracted.add('ordered-branch-statement-scan');
        const effects = orderedBranchEffects(branch, fn);
        if (effects.truncated) extracted.add('unconditional-terminal-truncation');
        if (effects.terminalEffects) extracted.add('terminal-expression-side-effects');
        const shape = branchShape(branch);
        if (shape === 'terminal' || shape === 'regular') continue;
        // A compound branch truncated by an explicit unconditional terminal is the
        // one ordered form we support; it is no longer an unsupported non-direct branch.
        if (effects.truncated && !effects.complex) continue;
        gaps.add(shape === 'else-if' ? 'else-if-chain' : 'non-direct-branch');
      }
      for (const fact of guard.comparisons) if (reassignmentBefore(fact, fn)) gaps.add('subject-reassignment-value-flow');
      if (guard.comparisons.length) extracted.add('literal-equality-action');
      if (hasDynamicProperty(guard.condition)) gaps.add('dynamic-property-access');
      for (const className of guard.classes) if (className.startsWith('negated')) extracted.add(className);
      if (!guard.conditionSupported && guard.comparisons.length) gaps.add('compound-condition-polarity-unsupported');
    }
    const gateGuard = guards.find(guard => guard.shape) || guards.find(guard => guard.exits.length) || null;
    let permissionGate = null;
    if (gateGuard) {
      const bounded = boundedString(gateGuard.condition.getText(), 240);
      const rejectExit = gateGuard.exits.find(exit => exitPolarity(gateGuard, exit.branch) === 'not-equals-literal')
        || gateGuard.exits.find(exit => literalActionsFrom(exit.node.getExpression()).length > 0)
        || gateGuard.exits[0];
      const rejectStatement = rejectExit?.branch === 'then'
        ? gateGuard.stmt.getThenStatement() : gateGuard.stmt.getElseStatement();
      permissionGate = { expression: bounded.text, location: loc(gateGuard.condition), truncated: bounded.truncated,
        rejectBranch: rejectStatement ? loc(rejectStatement) : null };
      if (gateGuard.shape === 'union') extracted.add('negated-union-guard');
      else if (gateGuard.shape === 'single') extracted.add('negated-single-guard');
      else extracted.add('conditional-equality-guard');
      if (bounded.truncated) localTruncations.push({ kind: 'permission-gate-expression', location: loc(gateGuard.condition),
        limit: 240, retained: 240, total: gateGuard.condition.getWidth() });
    }
    const actionCandidates = info.candidateDrafts.map(draft => draft.candidate);
    const supportedCandidates = info.candidateDrafts.filter(d =>
      d.candidate.status === 'candidate'
      && (d.candidate.relation === 'same-function' || d.candidate.relation === 'traceable-call'));
    let acceptsAction = null;
    if (supportedCandidates.length === 1) {
      const draft = supportedCandidates[0], cmp = draft.fact;
      if (cmp.status === 'supported' && draft.equalsPath === (isEqualsOperator(cmp.operator) ? 'then' : 'else')) {
        const bounded = boundedString(draft.candidate.action, 240);
        acceptsAction = { action: bounded.text, location: draft.candidate.target.location, truncated: bounded.truncated };
        extracted.add('success-entry-literal');
      }
    }
    if (localAcceptance) extracted.add('literal-equality-acceptance');
    if (actionCandidates.length) extracted.add('action-candidates');
    if (info.comparisons.length) extracted.add('entry-comparisons');
    extracted.add('ast-literal-action-values');
    if (!guards.length && !localAcceptance && !declaredDescription && !info.comparisons.length) continue;
    const scopeMap = new Map();
    for (const guard of guards) for (const branch of guard.successBranches)
      for (const node of nodesInBranch(branch, fn)) scopeMap.set(nodeKey(node), node);
    if (!scopeMap.size) for (const node of fn.getDescendants()) if (owner(node) === fn) scopeMap.set(nodeKey(node), node);
    const scopeNodes = [...scopeMap.values()];
    const conditionMemberNodes = dedupeBy(guards.flatMap(guard => conditionNodes(guard.condition)).filter(node => !!member(node)), nodeKey);
    const scopeMemberNodes = dedupeBy(scopeNodes.filter(node => !!member(node)), nodeKey);
    const conditionKeys = new Set(conditionMemberNodes.map(nodeKey));
    const readNodes = dedupeBy([...conditionMemberNodes, ...scopeMemberNodes], nodeKey);
    if (readNodes.length > 32) localTruncations.push({ kind: 'state-reads', location: loc(fn),
      limit: 32, retained: 32, total: readNodes.length });
    const stateReads = readNodes.slice(0, 32).map(node => ({ location: loc(node),
      symbol: model.symbolInfo(member(node).keyNode || node), expression: node.getText(),
      role: conditionKeys.has(nodeKey(node)) ? 'condition-read-candidate' : 'scope-read-candidate' }));
    const callNodes = dedupeBy([...guards.flatMap(guard => conditionNodes(guard.condition)).filter(Node.isCallExpression),
      ...scopeNodes.filter(Node.isCallExpression)], nodeKey);
    if (callNodes.length > 32) localTruncations.push({ kind: 'calls', location: loc(fn),
      limit: 32, retained: 32, total: callNodes.length });
    const calls = [], receiverCalls = [];
    let unresolvedCallees = 0;
    for (const call of callNodes.slice(0, 32)) {
      const ids = calledFunctionIds(call);
      if (!ids.length) unresolvedCallees += 1;
      for (const id of ids) if (!calls.includes(id)) calls.push(id);
      receiverCalls.push(call);
    }
    const receivers = dedupeBy(receiverCalls.filter(call => !!member(call.getExpression())?.base).slice(0, 16), nodeKey)
      .map(call => {
        const base = member(call.getExpression()).base;
        extracted.add('trace-receiver');
        return { name: base.getText(), provenance: trace(base).map(model.serialize) };
      });
    if (receiverCalls.length > 16) localTruncations.push({ kind: 'receivers', location: loc(fn),
      limit: 16, retained: 16, total: receiverCalls.length });
    const writeNodes = dedupeBy([
      ...scopeNodes.filter(node => Node.isBinaryExpression(node) && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken)
        .map(node => ({ node, role: 'assignment-syntax-candidate' })),
      ...callNodes.slice(0, 32).map(node => ({ node, role: 'call-side-effect-candidate' }))
    ], item => nodeKey(item.node));
    if (writeNodes.length > 32) localTruncations.push({ kind: 'state-writes', location: loc(fn),
      limit: 32, retained: 32, total: writeNodes.length });
    const stateWrites = writeNodes.slice(0, 32).map(({ node, role }) => {
      if (role === 'call-side-effect-candidate') {
        extracted.add('call-side-effect-candidate');
        return { location: loc(node), expression: node.getText(), callee: node.getExpression().getText(),
          role, calleeSemantics: 'unresolved by name' };
      }
      extracted.add('assignment-syntax-candidate');
      const left = unwrapExpression(node.getLeft());
      return { location: loc(node), expression: node.getText(), role,
        symbol: model.symbolInfo(member(left)?.keyNode || left) };
    });
    const returnUses = [];
    for (const node of exitNodes.filter(node => Node.isReturnStatement(node))) {
      const sites = model.incoming.get(nodeKey(fn)) || [];
      returnUses.push({ location: loc(node), expression: node.getExpression()?.getText() || '',
        incomingCalls: sites.slice(0, 12).map(loc), incomingTruncated: sites.length > 12 });
      if (sites.length) extracted.add('incoming-return-use');
      if (sites.length > 12) localTruncations.push({ kind: 'incoming-return-uses', location: loc(node),
        limit: 12, retained: 12, total: sites.length });
    }
    const lifecycleCandidates = [];
    for (const effect of (phases.effects || []).filter(item => item.parent === fnId || item.setup === fnId || (item.cleanup || []).includes(fnId))) {
      lifecycleCandidates.push({ kind: 'effect', call: effect.call, parent: effect.parent,
        setup: effect.setup, cleanup: effect.cleanup, status: effect.status || null, assumption: effect.assumption || null });
      extracted.add('lifecycle-effect-candidate');
    }
    for (const resource of (phases.resources || []).filter(item => (item.releaseInvocation || []).some(site => site.function === fnId))) {
      lifecycleCandidates.push({ kind: 'resource', variable: resource.variable, acquisition: resource.acquisition,
        releaseInvocation: resource.releaseInvocation, resetAssignments: resource.resetAssignments, conclusion: resource.conclusion });
      extracted.add('lifecycle-resource-candidate');
    }
    const traceResults = receivers.flatMap(receiver => receiver.provenance || []);
    const baseStatus = provenanceStatus(traceResults);
    const uncertainty = [...baseStatus.uncertainty, { kind: 'entry-conditions-syntax-only',
      location: loc(fn), notRuntimeProof: true, authorDescription: declaredDescription ? 'author-declared; not verified runtime behavior' : null }];
    if (info.comparisons.some(fact => reassignmentBefore(fact, fn)))
      uncertainty.push({ kind: 'subject-reassignment-value-flow', location: loc(fn), notRuntimeProof: true });
    if (!guards.length) uncertainty.push({ kind: 'entry-guard-absent', location: loc(fn) });
    if (!permissionGate) uncertainty.push({ kind: 'permission-gate-shape-absent', location: loc(fn) });
    if (!acceptsAction) uncertainty.push({ kind: 'accepting-entry-unmatched', location: loc(fn) });
    if (unresolvedCallees) uncertainty.push({ kind: 'unresolved-callee-side-effects', location: loc(fn), count: unresolvedCallees });
    const status = {
      candidateSetComplete: baseStatus.candidateSetComplete && localTruncations.length === 0 && gaps.size === ENTRY_GAPS.size,
      conditional: true,
      multipleSources: baseStatus.multipleSources || actionCandidates.length > 1 || (model.incoming.get(nodeKey(fn)) || []).length > 1,
      unresolved: baseStatus.unresolved || !guards.length || !permissionGate || !acceptsAction
        || supportedCandidates.length === 0 || unresolvedCallees > 0,
      uncertainty: dedupeJson(uncertainty),
      truncations: dedupeJson([...baseStatus.truncations, ...localTruncations]),
      assumptions: [...new Set([...(baseStatus.assumptions || []),
        'Literal strings are action candidates only; no name or comment inference',
        'Author description comes from a string literal near registration',
        'Direct early exits are attributed by callable owner'])]
    };
    records.push({ id: `H${String(records.length + 1).padStart(4, '0')}`, originalId: null,
      function: fnId, kind: 'entry-condition', location: loc(fn),
      entry: { permissionGate, earlyExits, comparisons: info.comparisons, actionCandidates, acceptsAction, declaredDescription },
      relations: { calls, stateReads, stateWrites, receivers, returnUses, lifecycleCandidates },
      status, support: { extracted: [...extracted].sort(), notSupported: [...gaps].sort() } });
  }
  return records;
}
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
      wiring.push({status,id:`W${String(wiring.length+1).padStart(3,'0')}`,use:loc(call),member:literalMethod,receiver:access.base.getText(),compilerReceiver:model.symbolInfo(access.base),compilerMember:model.symbolInfo(access.keyNode),binding:bases.map(loc),relations:targets.map(model.serialize),attribution:'Compiler symbol/type facts are separate from syntax-guided argument/destructure/factory relation candidates',calleeFunctions:targets.filter(r=>r.kind==='definition'&&callable(r.node)).map(r=>functionId(r.node)).filter(Boolean)});
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
  const limits=[...model.limitations,'Only supported literal properties, direct identifier call sites, assignments and factory return candidates are traversed. No complete control/data-flow or runtime call graph.', 'Assignments/returns are candidate alternatives; reachability and object mutation/monkey patching are not solved.', 'Any/unknown and missing host/node declarations remain explicit. No fabricated declarations added.','findReferences scope is current in-memory program, not runtime call completeness.','EntryConditions cover direct if/else terminal exits, negated literal/member guards and literal equality strings; arbitrary control flow, dynamic property joins, cross-function data flow and nested callable attribution remain candidates only.'];
  for(const f of inventory)if(!fs.readFileSync(path.join(source,f.file)).equals(fs.readFileSync(path.join(snapshot,f.file))))throw new Error(`Input changed: ${f.file}`);
  const metadata={recordedAt:new Date().toISOString(),source,snapshot,version,rules:'morph-spike-2',entryRules:'entry-conditions-1',typescript:ts.version,runtime:{execPath:process.execPath,node:process.version,electron:process.versions.electron||null},sourceFiles:inventory.filter(f=>f.analyzed).length,sourceBytes:inventory.filter(f=>f.analyzed).reduce((n,f)=>n+f.bytes,0),loadMs:Math.round(loadMs),elapsedMs:Math.round(performance.now()-started),compilerOptions,projectOptions:{useInMemoryFileSystem:true,skipAddingFilesFromTsConfig:true,skipFileDependencyResolution:true},supplementalDeclarations:[],entryHostAssumption:'Only exported apply parameter 0 is interpreted as host-role candidate by convention; no host type proof'};
  const mutations=model.assignments.filter(x=>!!member(x.getLeft())).map(x=>({location:loc(x),function:functionId(owner(x)),left:loc(x.getLeft()),right:loc(x.getRight()),meaning:'Assignment syntax only; alias identity, actual execution and data ownership are not proved'}));
  const entryConditions=extractEntryConditions(model,callableNodes,functionId,{functions,edges,constructions,registrations,effects,toolBodies,resources,mutations,unresolvedCalls});
  const result={metadata,methodOwnership:a,wiring,phases:{functions,edges,constructions,registrations,effects,toolBodies,resources,mutations,unresolvedCalls,entryConditions},diagnostics,syntaxErrors,unknowns:limits};
  writeJson(path.join(out,'inventory.json'),{files:inventory,source,snapshot,positionBinding:'Exact retained source bytes; no upstream commit claim'});
  writeJson(path.join(out,'analysis.json'),result);
  const items=[...a.map(x=>({id:x.id,kind:'method',file:x.location.file,line:x.location.startLine,assessment:x.assessment,detail:x})),...wiring.map(x=>({id:x.id,kind:'wiring',file:x.use.file,line:x.use.startLine,member:x.member,detail:x})),...entryConditions.map(x=>({id:x.id,kind:'entry-condition',file:x.location.file,line:x.location.startLine,label:x.entry.actionCandidates?.[0]?.action??x.entry.acceptsAction?.action??x.kind,detail:x}))];
  for(const row of items)writeJson(path.join(out,'evidence',`${row.id}.json`),row.detail);
  writeJson(path.join(out,'reading-index.json'),{metadata,items:items.map(({detail,...r})=>({...r,path:`evidence/${r.id}.json`})),phases:'phase-index.json',unknowns:limits});
  writeJson(path.join(out,'phase-index.json'),{functions,edges,constructions,registrations,effects,toolBodies,resources,mutations,unresolvedCalls,entryConditions,warning:'Static candidate relations, not actual lifecycle execution or successful release'});
  writeJson(path.join(out,'measurements.json'),{...metadata,analysisBytes:fs.statSync(path.join(out,'analysis.json')).size,indexBytes:fs.statSync(path.join(out,'reading-index.json')).size,phaseBytes:fs.statSync(path.join(out,'phase-index.json')).size,methodCandidates:a.length,wiringSites:wiring.length,entryConditions:entryConditions.length,diagnostics:diagnostics.length,syntaxErrors:syntaxErrors.length,tokenUsage:null});
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [source,out]=process.argv.slice(2);if(!source||!out)throw new Error('morph-scan.mjs SOURCE FRESH_OUT');
  const r=await morphScan(source,out);console.log(JSON.stringify({metadata:r.metadata,methods:r.methodOwnership.length,wiring:r.wiring.length,diagnostics:r.diagnostics.length,resources:r.phases.resources.length}));
}
