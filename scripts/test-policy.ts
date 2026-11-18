import ts from 'typescript';

export const testInclude = ['{apps,packages,scripts,e2e}/**/*.{test,spec}.{ts,tsx}'];
export const integrationInclude = [
  '{apps,packages,scripts,e2e}/**/*.integration.{test,spec}.{ts,tsx}',
];
export const testExclude = ['**/node_modules/**', '**/dist/**'];

const testNames = new Set(['it', 'test', 'describe', 'suite']);
const forbiddenModifiers = new Set([
  'only',
  'skip',
  'todo',
  'skipIf',
  'runIf',
  'fails',
  'fail',
  'fixme',
]);

function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
}

export function findForbiddenTestModifiers(paths: string[]): string[] {
  // Resolve local import bindings and shadowing without loading application dependencies.
  const program = ts.createProgram(paths, { noResolve: true, noLib: true, types: [] });
  const checker = program.getTypeChecker();
  const violations: string[] = [];
  for (const path of paths) {
    const source = program.getSourceFile(path);
    if (!source) throw new Error(`Cannot read test source: ${path}`);
    const tests = new Set<ts.Symbol>();
    const namespaces = new Set<ts.Symbol>();
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== 'vitest'
      )
        continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings) continue;
      if (ts.isNamespaceImport(bindings)) {
        const symbol = checker.getSymbolAtLocation(bindings.name);
        if (symbol) namespaces.add(symbol);
      } else {
        for (const binding of bindings.elements) {
          if (!testNames.has((binding.propertyName ?? binding.name).text)) continue;
          const symbol = checker.getSymbolAtLocation(binding.name);
          if (symbol) tests.add(symbol);
        }
      }
    }
    function isTestBuilder(node: ts.Expression): boolean {
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        return symbol !== undefined && tests.has(symbol);
      }
      if (ts.isCallExpression(node) || ts.isParenthesizedExpression(node)) {
        return isTestBuilder(node.expression);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const name = memberName(node);
        if (name && testNames.has(name) && ts.isIdentifier(node.expression)) {
          const symbol = checker.getSymbolAtLocation(node.expression);
          if (symbol && namespaces.has(symbol)) return true;
        }
        return isTestBuilder(node.expression);
      }
      return false;
    }
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const name = memberName(node);
        if (name && forbiddenModifiers.has(name) && isTestBuilder(node.expression)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${path}:${line + 1}: forbidden test modifier .${name}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}
