import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface LumiReleaseEnvironment {
  publish: boolean
  refType?: string
  refName?: string
}

interface PackageManifest {
  version?: string
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  build?: {
    appId?: string
    productName?: string
    artifactName?: string
    directories?: { buildResources?: string; output?: string }
    win?: { forceCodeSigning?: boolean; verifyUpdateCodeSignature?: boolean; icon?: string }
    publish?: Array<{ provider?: string; owner?: string; repo?: string; releaseType?: string }>
  }
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Read one repository JSON object. */
function manifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as PackageManifest
}

/**
 * Validate the source-controlled Windows release definition and an optional
 * publication request.
 * @param environment Release intent and Git ref supplied by GitHub Actions.
 * @returns Every rejection; an empty list means the definition is coherent.
 */
export function lumiReleaseErrors(environment: LumiReleaseEnvironment): string[] {
  const errors: string[] = []
  const repository = manifest('package.json')
  const desktop = manifest('apps/desktop/package.json')
  if (repository.version === undefined || desktop.version !== repository.version) {
    errors.push('root and desktop versions must be identical')
  }
  if (desktop.private !== true) errors.push('the installable desktop app must stay private on npm')
  if (desktop.dependencies?.['electron-updater'] === undefined) errors.push('electron-updater must be a runtime dependency')
  if (desktop.devDependencies?.['electron-builder'] === undefined) errors.push('electron-builder must be a development dependency')
  if (desktop.build?.appId !== 'io.github.cheshiremew.lumi') errors.push('the Windows app id must remain stable')
  if (desktop.build?.productName !== 'Lumi') errors.push('the Windows product name must be Lumi')
  if (desktop.build?.artifactName !== 'Lumi-Setup-${version}-${arch}.${ext}') errors.push('the installer name must carry version and architecture')
  if (desktop.build?.win?.forceCodeSigning !== true) errors.push('production Windows packaging must fail without code signing')
  if (desktop.build?.win?.verifyUpdateCodeSignature !== true) errors.push('Windows updates must verify the executable signature')
  const icon = desktop.build?.win?.icon
  if (icon === undefined || !existsSync(resolve(root, 'apps/desktop', icon))) errors.push('the configured Lumi application icon must exist')
  const provider = desktop.build?.publish?.[0]
  if (provider?.provider !== 'github' || provider.owner !== 'CheshireMew' || provider.repo !== 'dsh-Lumi' || provider.releaseType !== 'draft') {
    errors.push('desktop releases must publish as a draft in CheshireMew/dsh-Lumi')
  }
  if (environment.publish) {
    const expected = `lumi-v${desktop.version ?? ''}`
    if (environment.refType !== 'tag' || environment.refName !== expected) {
      errors.push(`publication must run from the exact ${expected} tag`)
    }
  }
  return errors
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = lumiReleaseErrors({
    publish: process.env['RELEASE_PUBLISH'] === 'true',
    ...(process.env['GITHUB_REF_TYPE'] === undefined ? {} : { refType: process.env['GITHUB_REF_TYPE'] }),
    ...(process.env['GITHUB_REF_NAME'] === undefined ? {} : { refName: process.env['GITHUB_REF_NAME'] }),
  })
  if (errors.length > 0) {
    for (const error of errors) console.error(`lumi-release: ${error}`)
    process.exitCode = 1
  } else {
    console.log('Lumi desktop release definition is coherent.')
  }
}
