import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  source: {
    entry: { index: './src/index.mjs' },
  },
  output: {
    target: 'node',
    distPath: { root: 'dist' },
    externals: { '@machinen/runtime': 'import @machinen/runtime' },
  },
  tools: {
    rspack: {
      module: {
        parser: {
          javascript: { dynamicImportMode: 'eager' },
        },
      },
    },
  },
});
