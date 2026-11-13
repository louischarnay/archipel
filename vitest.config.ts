import { defineConfig } from 'vitest/config';

// Same sources as `npm run dev`: the tests do not depend on an up-to-date `dist`.
const conditions = ['@archipel/source', 'node'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  // NestJS injects by constructor type: the transform must emit the decorator metadata, as `tsc` does.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: { include: ['packages/*/test/**/*.test.ts'], environment: 'node' },
});
