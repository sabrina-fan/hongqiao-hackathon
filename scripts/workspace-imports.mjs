import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
function workspace(path) {
  const [group, name] = relative(root, path).split(sep);
  if ((group === 'apps' || group === 'packages') && name) return `${group}/${name}`;
}

export default {
  rules: {
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
