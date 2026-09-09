import ts from 'typescript';

/** Inspect supported module syntax without importing or executing application code.
 * The build bundles this parser so the installed runtime needs no TypeScript package.
 */
export function inspectSourceImports(source: string, fileName: string): string[] {
  return [...new Set(inspectSourceDependencies(source, fileName).map(item => item.specifier))];
}

export interface SourceDependency { specifier: string; kind: 'import' | 'require'; typeOnly: boolean }

export function inspectSourceDependencies(source: string, fileName: string): SourceDependency[] {
  return inspectSourceModule(source, fileName).imports;
}

export function inspectSourceModule(source: string, fileName: string): { imports: SourceDependency[]; unsupported: string[] } {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) {
    throw new Error(`Unsupported or invalid module syntax in ${fileName}: ${ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, ' ')}`);
  }
  const imports: SourceDependency[] = [];
  const unsupported = new Set<string>();
  const add = (node: ts.Node | undefined, kind: 'import' | 'require', typeOnly = false) => {
    if (!node || !ts.isStringLiteralLike(node)) {
      throw new Error(`Computed module imports are unsupported in ${fileName}; use a literal import or require`);
    }
    imports.push({ specifier: node.text, kind, typeOnly });
    if (!typeOnly && ['vm', 'node:vm', 'child_process', 'node:child_process', 'worker_threads', 'node:worker_threads'].includes(node.text)) {
      unsupported.add(`External code execution API ${node.text}`);
    }
    if (!typeOnly && ['module', 'node:module'].includes(node.text)) unsupported.add('Custom module resolution API');
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      const onlyNamedTypes = !node.importClause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly);
      add(node.moduleSpecifier, 'import', node.importClause?.isTypeOnly === true || !!onlyNamedTypes);
    } else if (ts.isExportDeclaration(node)) {
      const onlyNamedTypes = node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly);
      if (node.moduleSpecifier) add(node.moduleSpecifier, 'import', node.isTypeOnly || !!onlyNamedTypes);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, 'require', node.isTypeOnly);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0], node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require');
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'require' && node.expression.name.text === 'resolve') {
      add(node.arguments[0], 'require');
      if (node.arguments.length > 1) unsupported.add('Custom require.resolve search paths');
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)
      && ['eval', 'Function'].includes(node.expression.text)) unsupported.add('Dynamically generated code');
    const loaderMembers = ['require', 'dlopen', '_load', 'register', 'registerHooks', 'createRequire', 'eval', 'Function'];
    if ((ts.isPropertyAccessExpression(node) && loaderMembers.includes(node.name.text))
      || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && loaderMembers.includes(node.argumentExpression.text))) {
      unsupported.add('Custom code/module loader');
    }
    if (ts.isIdentifier(node) && ['require', 'eval', 'Function'].includes(node.text)) {
      const parent = node.parent;
      if ((ts.isVariableDeclaration(parent) && parent.initializer === node)
        || (ts.isBinaryExpression(parent) && parent.right === node)
        || (ts.isPropertyAssignment(parent) && parent.initializer === node)) unsupported.add('Aliased code/module loader');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { imports, unsupported: [...unsupported] };
}
