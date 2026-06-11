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
    // The native VM runtime must NOT be bundled: it resolves its asset dir
    // (base rootfs, kernels) from its own on-disk package.json, which an
    // inlined copy cannot see (it would fall back to a bogus version and an
    // empty asset dir). Kept a real dynamic import; the machinen driver only
    // loads it on first VM boot.
    externals: { '@machinen/runtime': 'import @machinen/runtime' },
  },
});
