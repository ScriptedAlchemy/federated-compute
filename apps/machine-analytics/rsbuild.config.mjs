import { defineConfig } from '@rsbuild/core';

// Bundled like apps/remote so the published image (`GET /mf-image`) is a
// self-contained guest program: a consumer can pull it into a cache dir
// anywhere and boot it without this repo's node_modules around.
export default defineConfig({
  source: {
    entry: { index: './src/index.mjs' },
  },
  output: {
    target: 'node',
    distPath: { root: 'dist' },
  },
});
