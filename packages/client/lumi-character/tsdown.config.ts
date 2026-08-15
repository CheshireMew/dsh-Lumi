import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@dsh-lumi/client-character',
  ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/pack-contract.js'],
  { hostPhase: true },
)
