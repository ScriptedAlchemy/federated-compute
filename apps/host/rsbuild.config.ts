import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  source: {
    entry: {
      index: './src/index.ts',
      server: './src/server.ts',
      'region-agent': './src/region-agent.ts',
    },
  },
  output: {
    target: 'node',
    distPath: { root: 'dist' },
    // The machinen runtime ships native VMM binaries and resolves sibling
    // assets relative to its own install path — it must stay a real
    // node_modules import at runtime, never a bundled chunk.
    externals: { '@machinen/runtime': 'import @machinen/runtime' },
  },
});
