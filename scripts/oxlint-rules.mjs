import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
function workspace(path) {
  const [group, name] = relative(root, path).split(sep);
  if ((group === 'apps' || group === 'packages') && name) return `${group}/${name}`;
}

export default {
  rules: {
    'no-chained-type-assertions': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          chained: '双重类型断言绕过了类型检查；请在输入边界用 schema 校验或用类型守卫收窄。',
        },
      },
      create(context) {
        function check(node) {
          let inner = node.expression;
          while (inner.type === 'ParenthesizedExpression') inner = inner.expression;
          if (inner.type === 'TSAsExpression' || inner.type === 'TSTypeAssertion') {
            context.report({ node, messageId: 'chained' });
          }
        }
        return { TSAsExpression: check, TSTypeAssertion: check };
      },
    },
    'public-imports': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          crossPackage: '不要通过相对路径跨包；使用 @nextstop 包的公开入口。',
        },
      },
      create(context) {
        const filename = context.filename;
        const owner = workspace(filename);
        function check(node) {
          const source = node.source;
          if (typeof source?.value !== 'string' || !source.value.startsWith('.')) return;
          const target = workspace(resolve(dirname(filename), source.value));
          if (owner !== target && (owner || target)) {
            context.report({ node: source, messageId: 'crossPackage' });
          }
        }
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ImportExpression: check,
        };
      },
    },
  },
};
