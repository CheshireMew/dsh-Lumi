import { defineConfig } from 'tsdown'

/**
 * The dsh package ships the `bin` executable plus the public `profile-boot`
 * entry used by embedded launchers. The root tsdown builds only
 * `lib/types/index.js`, so this override names both real entries explicitly;
 * their reachable modules may share generated chunks.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/profile-boot.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
