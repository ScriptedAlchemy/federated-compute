import { defineConfig } from '@rsbuild/core';

export default defineConfig({
  source: {
    entry: {
      index: './src/index.ts',
      server: './src/server.ts',
    },
  },
  output: {
    target: 'node',
    distPath: { root: 'dist' },
  },
});
