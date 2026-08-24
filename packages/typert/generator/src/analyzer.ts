/**
 * TypeScript project analyzer for the compiler-independent Typert model.
 * Programs, symbols, and syntax nodes remain extraction-only implementation
 * details; callers receive only the model declared in {@link ./model.ts}.
 * @module @deepseek-ai/dsh-typert-generator/analyzer
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import type {
  CrossFaceLink,
  EventModel,
  FaceModel,
  ObjectModel,
  PackageModel,
  SchemaModel,
  ServiceModel,
  SourceDeclarationModel,
  SymbolId,
  TypertFace,
  WorkspaceModel,
} from './model.ts'
import {
  SourceEditQueued,
  TypertAnalysisError,
  type AnalysisMode,
  type ExportRecord,
  type FaceAnalyzerOptions,
  type PackageRegistration,
  type ParsedConfig,
  type SourceEdit,
} from './analysis-internals.ts'
import {
  clientExportSubpaths,
  compareCrossFaceLinks,
  declarationText,
  documentationOf,
  exposableMember,
  formatProgramDiagnostic,
  hasModifier,
  hasPackageSurface,
  hostExportSubpaths,
  isDualFacePackage,
  isRemoteSegment,
  isStandardLibraryFile,
  isTypeDeclaration,
  isWithin,
  memberName,
  mergeWorkspaceModels,
  moduleIdentity,
  packageExportTargets,
  parseConfig,
  preferredDeclaration,
  projectConfigPath,
  realPath,
  slash,
  sourceFileHasSurface,
  sourcePathForExport,
  typertMode,
  typertServiceTag,
  uniqueBy,
} from './analyzer-utils.ts'
import { FaceRemoteAnalyzer } from './face-remote-analyzer.ts'
export { TypertAnalysisError } from './analysis-internals.ts'
export type { AnalysisMode, PackageRegistration, ParsedConfig } from './analysis-internals.ts'

/** Workspace analysis configuration. */
export interface WorkspaceAnalyzerOptions {
  /** Workspace root containing the face tsconfigs. */
  readonly root: string
  /** Host aggregate path, relative to {@link root}; absent files are skipped. */
  readonly hostConfig?: string
  /** Client aggregate path, relative to {@link root}; absent files are skipped. */
  readonly clientConfig?: string
  /** Optional package-name subset for an incremental generation pass. */
  readonly packages?: readonly string[]
  /** Independently compiled faces to materialize; both are analyzed by default. */
  readonly faces?: readonly TypertFace[]
  /** Whether to repeat TypeScript project diagnostics before model extraction. */
  readonly checkDiagnostics?: boolean
  /** Whether missing annotations fail or are written before a clean re-analysis. */
  readonly mode?: AnalysisMode
  /** Shared workspace memo; supply one instance to reuse parses across analyzers. */
  readonly caches?: WorkspaceCaches
}

/** One package face whose public export graph contains Typert business declarations. */
export interface DiscoveredTypertPackage {
  readonly package: string
  readonly root: string
  readonly faces: readonly TypertFace[]
}


interface FaceProgramHost {
  readonly host: ts.CompilerHost
  readonly files: Map<string, ts.SourceFile | undefined>
}

/**
 * Process-wide parse cache for the bundled TypeScript default libraries.
 * `typescript/lib/lib.*.d.ts` content is immutable for the process lifetime,
 * so parses are shared across every {@link WorkspaceCaches} instance; the key
 * carries the parse-affecting settings, keeping reuse exact.
 */
const defaultLibraryParses = new Map<string, ts.SourceFile | undefined>()

function defaultLibraryKey(fileName: string, languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions): string {
  const options = typeof languageVersionOrOptions === 'object'
    ? languageVersionOrOptions
    : { languageVersion: languageVersionOrOptions }
  return [
    fileName,
    String(options.languageVersion),
    String(options.impliedNodeFormat ?? ''),
    String(options.jsDocParsingMode ?? ''),
  ].join('\0')
}

/**
 * Shared memo over one immutable workspace snapshot. Passing one instance to
 * several analyzers (the batched and write-mode children reuse their parent's
 * automatically) reuses parsed tsconfigs, the registration inventory, and
 * per-face compiler hosts whose parsed and bound source files and module
 * resolutions carry across programs. Callers that mutate workspace files
 * between analyses must start from a fresh instance; write-mode source edits
 * invalidate themselves through {@link invalidate}.
 */
export class WorkspaceCaches {
  /** Parsed tsconfig files by absolute config path. */
  readonly configs = new Map<string, ParsedConfig>()
  /** Registration inventories keyed by root and aggregate config paths. */
  readonly registrations = new Map<string, PackageRegistration[]>()
  private readonly hosts = new Map<TypertFace, FaceProgramHost>()

  /**
   * Parse one tsconfig once per workspace snapshot.
   * @param path - absolute config path.
   * @returns the memoized parse result.
   */
  config(path: string): ParsedConfig {
    let parsed = this.configs.get(path)
    if (parsed === undefined) {
      parsed = parseConfig(path)
      this.configs.set(path, parsed)
    }
    return parsed
  }

  /**
   * Return the shared compiler host for one face. Every program of one face
   * is built from the same aggregate compiler options (the first call wins),
   * so parsed source files, binder state, and module resolutions are safe to
   * reuse across the face's batched programs.
   * @param face - the face whose programs share this host.
   * @param options - the face's effective compiler options.
   * @returns a compiler host with source-file and module-resolution caches.
   */
  programHost(face: TypertFace, options: ts.CompilerOptions): ts.CompilerHost {
    let entry = this.hosts.get(face)
    if (entry === undefined) {
      const host = ts.createCompilerHost(options)
      const files = new Map<string, ts.SourceFile | undefined>()
      const resolutionCache = ts.createModuleResolutionCache(
        host.getCurrentDirectory(),
        fileName => host.getCanonicalFileName(fileName),
        options,
      )
      const base = host.getSourceFile.bind(host)
      // The snapshot contract makes shouldCreateNewSourceFile irrelevant: it
      // only fires under oldProgram reuse, which these fresh programs never
      // request, and invalidate() is the one supported re-read path.
      host.getSourceFile = (fileName, languageVersionOrOptions, onError) => {
        if (isStandardLibraryFile(fileName)) {
          const key = defaultLibraryKey(fileName, languageVersionOrOptions)
          if (!defaultLibraryParses.has(key)) {
            defaultLibraryParses.set(key, base(fileName, languageVersionOrOptions, onError))
          }
          return defaultLibraryParses.get(key)
        }
        if (!files.has(fileName)) files.set(fileName, base(fileName, languageVersionOrOptions, onError))
        return files.get(fileName)
      }
      host.getModuleResolutionCache = () => resolutionCache
      entry = { host, files }
      this.hosts.set(face, entry)
    }
    return entry.host
  }

  /**
   * Drop cached parses of one edited source file so the next analysis reads
   * the written content.
   * @param file - path of the edited file.
   */
  invalidate(file: string): void {
    const target = realPath(file)
    for (const { files } of this.hosts.values()) {
      for (const key of [...files.keys()]) {
        if (realPath(key) === target) files.delete(key)
      }
    }
  }
}

/** Analyze host and client as independent TypeScript programs. */
export class WorkspaceAnalyzer {
  private readonly options: Required<Pick<
    WorkspaceAnalyzerOptions,
    'root' | 'hostConfig' | 'clientConfig' | 'faces' | 'checkDiagnostics' | 'mode'
  >> & Pick<WorkspaceAnalyzerOptions, 'packages'>
  private queuedEdit: SourceEdit | undefined
  private readonly crossFaceLinks = new Map<string, CrossFaceLink>()
  private readonly checkedProjects = new Set<string>()
  private registrations: PackageRegistration[] = []
  private readonly caches: WorkspaceCaches

  constructor(options: WorkspaceAnalyzerOptions) {
    this.options = {
      root: realPath(options.root),
      hostConfig: options.hostConfig ?? 'tsconfig.host.json',
      clientConfig: options.clientConfig ?? 'tsconfig.client.json',
      faces: options.faces ?? ['host', 'client'],
      checkDiagnostics: options.checkDiagnostics ?? true,
      mode: options.mode ?? 'check',
      ...(options.packages === undefined ? {} : { packages: options.packages }),
    }
    this.caches = options.caches ?? new WorkspaceCaches()
  }

  /**
   * Build the workspace model. Write mode applies inferred annotations and then
   * returns a fresh check-mode analysis of the edited projects.
   * @returns the independent face models and their explicit cross-face links.
   */
  analyze(): WorkspaceModel {
    this.registrations = this.loadRegistrations()
    const selected = this.options.packages === undefined
      ? undefined
      : new Set(this.options.packages)
    const faces: FaceModel[] = []
    try {
      for (const face of this.options.faces) {
        const registrations = this.registrations.filter(registration =>
          registration.face === face && (selected === undefined || selected.has(registration.name)))
        if (registrations.length === 0) continue
        if (this.options.checkDiagnostics) {
          for (const registration of registrations) this.checkProject(registration)
        }
        const aggregatePath = resolve(this.options.root, face === 'host' ? this.options.hostConfig : this.options.clientConfig)
        const aggregate = this.caches.config(aggregatePath)
        const rootNames = [...new Set(registrations.flatMap(registration => registration.config.parsed.fileNames))]
        const options: ts.CompilerOptions = {
          ...aggregate.parsed.options,
          composite: false,
          incremental: false,
          noEmit: true,
        }
        const program = ts.createProgram({
          rootNames,
          options,
          host: this.caches.programHost(face, options),
        })
        faces.push(new FaceAnalyzer({
          root: this.options.root,
          face,
          program,
          registrations,
          allRegistrations: this.registrations,
          mode: this.options.mode,
          queueEdit: (edit) => { this.queueEdit(edit) },
          crossFaceLinks: this.crossFaceLinks,
        }).analyze())
      }
    } catch (error) {
      if (!(error instanceof SourceEditQueued) || this.options.mode !== 'write' || this.queuedEdit === undefined) throw error
    }

    if (this.queuedEdit !== undefined) {
      this.applyEdit(this.queuedEdit)
      return new WorkspaceAnalyzer({ ...this.options, caches: this.caches, mode: 'write' }).analyze()
    }

    if (this.options.mode === 'write') {
      return new WorkspaceAnalyzer({ ...this.options, caches: this.caches, mode: 'check' }).analyze()
    }

    return {
      faces,
      crossFaceLinks: [...this.crossFaceLinks.values()].sort(compareCrossFaceLinks),
    }
  }

  /**
   * Analyze an explicit package selection through bounded compiler programs.
   * The resulting model is identical in shape to {@link analyze}; stable graph
   * ids let repeated dependency declarations merge without flattening types.
   * @param batchSize - maximum selected packages in one face program.
   * @returns one merged workspace model.
   */
  analyzeInBatches(batchSize = 8): WorkspaceModel {
    if (this.options.packages === undefined) {
      throw new TypertAnalysisError('typert: batched analysis requires an explicit package selection')
    }
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new TypertAnalysisError(`typert: batch size must be a positive integer, received ${String(batchSize)}`)
    }
    const batches: WorkspaceModel[] = []
    for (let index = 0; index < this.options.packages.length; index += batchSize) {
      batches.push(new WorkspaceAnalyzer({
        ...this.options,
        caches: this.caches,
        packages: this.options.packages.slice(index, index + batchSize),
      }).analyze())
    }
    return mergeWorkspaceModels(batches)
  }

  /**
   * Discover package faces from public-export-reachable Cordis augmentations
   * and explicit `@typert` roots without constructing a type-checker program.
   * @returns contributors grouped by package with deterministic face order.
   */
  discoverPackages(): DiscoveredTypertPackage[] {
    const registrations = this.loadRegistrations()
      .filter(registration => this.options.faces.includes(registration.face))
      .filter(registration => this.registrationHasSurface(registration))
    const packages = new Map<string, { root: string; faces: Set<TypertFace> }>()
    for (const registration of registrations) {
      const current = packages.get(registration.name) ?? {
        root: slash(relative(this.options.root, registration.root)),
        faces: new Set<TypertFace>(),
      }
      current.faces.add(registration.face)
      packages.set(registration.name, current)
    }
    return [...packages]
      .map(([packageName, value]) => ({
        package: packageName,
        root: value.root,
        faces: [...value.faces].sort(),
      }))
      .sort((left, right) => left.package.localeCompare(right.package))
  }

  /**
   * Index top-level exported type declarations without promoting them to graph
   * roots. Consumers use this lexical index for ambiguity checks while all
   * semantic traversal continues through {@link TypeGraph}.
   * @returns declarations from the selected faces and package projects.
   */
  indexSourceDeclarations(): SourceDeclarationModel[] {
    const selected = this.options.packages === undefined ? undefined : new Set(this.options.packages)
    const declarations: SourceDeclarationModel[] = []
    for (const registration of this.loadRegistrations()) {
      if (!this.options.faces.includes(registration.face)
        || (selected !== undefined && !selected.has(registration.name))) continue
      for (const file of registration.config.parsed.fileNames) {
        const relativeFile = slash(relative(this.options.root, file))
        if (!existsSync(file)
          || !isWithin(realPath(file), join(registration.root, 'src'))
          || !/\.(?:cts|mts|ts)$/.test(file)
        ) continue
        const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
        for (const statement of sourceFile.statements) {
          if (!isTypeDeclaration(statement)
            || statement.name === undefined
            || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
          const position = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
          declarations.push({
            face: registration.face,
            package: registration.name,
            name: statement.name.text,
            kind: ts.isClassDeclaration(statement)
              ? 'class'
              : ts.isInterfaceDeclaration(statement)
                ? 'interface'
                : ts.isTypeAliasDeclaration(statement)
                  ? 'alias'
                  : 'enum',
            location: {
              file: relativeFile,
              line: position.line + 1,
              column: position.character + 1,
            },
            text: declarationText(statement),
          })
        }
      }
    }
    return uniqueBy(declarations, declaration =>
      `${declaration.face}\0${declaration.location.file}\0${String(declaration.location.line)}\0${declaration.name}`)
      .sort((left, right) => left.face.localeCompare(right.face)
        || left.location.file.localeCompare(right.location.file)
        || left.location.line - right.location.line)
  }

  private loadRegistrations(): PackageRegistration[] {
    const inventoryKey = `${this.options.root}\0${this.options.hostConfig}\0${this.options.clientConfig}`
    const cached = this.caches.registrations.get(inventoryKey)
    if (cached !== undefined) return cached
    const registrations: PackageRegistration[] = []
    for (const face of ['host', 'client'] as const) {
      const aggregatePath = resolve(this.options.root, face === 'host' ? this.options.hostConfig : this.options.clientConfig)
      if (!existsSync(aggregatePath)) continue
      const aggregate = this.caches.config(aggregatePath)
      for (const reference of aggregate.parsed.projectReferences ?? []) {
        const configPath = projectConfigPath(reference.path)
        const packageRoot = dirname(configPath)
        if (!isWithin(realPath(packageRoot), join(this.options.root, 'packages'))) continue
        const manifestPath = join(packageRoot, 'package.json')
        if (!existsSync(manifestPath)) continue
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
        if (typeof manifest.name !== 'string') continue
        const registration: PackageRegistration = {
          face,
          name: manifest.name,
          root: realPath(packageRoot),
          config: this.caches.config(configPath),
          manifest,
        }
        if (!isDualFacePackage(manifest)) {
          registrations.push(registration)
        } else if (configPath === join(packageRoot, 'tsconfig.json')) {
          registrations.push(
            { ...registration, face: 'host', exportSubpaths: hostExportSubpaths(manifest) },
            { ...registration, face: 'client', exportSubpaths: clientExportSubpaths(manifest) },
          )
        } else {
          registrations.push({
            ...registration,
            exportSubpaths: face === 'host'
              ? hostExportSubpaths(manifest)
              : clientExportSubpaths(manifest),
          })
        }
      }
    }
    const inventory = uniqueBy(registrations, registration => `${registration.face}\0${registration.name}`)
      .sort((left, right) =>
        left.face.localeCompare(right.face) || left.name.localeCompare(right.name))
    this.caches.registrations.set(inventoryKey, inventory)
    return inventory
  }

  private entrySourcePaths(registration: PackageRegistration): string[] {
    return packageExportTargets(registration.manifest)
      .filter(([subpath, target]) => (registration.exportSubpaths === undefined
        || registration.exportSubpaths.includes(subpath))
        && !target.includes('*')
        && subpath !== './package.json'
        && subpath !== './typert'
        && subpath !== './client/typert'
        && subpath !== './remote'
        && !target.endsWith('.json'))
      .map(([, target]) => sourcePathForExport(registration.root, target))
      .filter(existsSync)
  }

  private registrationHasSurface(registration: PackageRegistration): boolean {
    const seen = new Set<string>()
    const queue = this.entrySourcePaths(registration)
    while (queue.length > 0) {
      const file = realPath(queue.shift() as string)
      if (seen.has(file) || !isWithin(file, registration.root)) continue
      seen.add(file)
      const source = readFileSync(file, 'utf8')
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      if (sourceFileHasSurface(sourceFile)) return true
      for (const imported of ts.preProcessFile(source).importedFiles) {
        const resolved = ts.resolveModuleName(
          imported.fileName,
          file,
          registration.config.parsed.options,
          ts.sys,
        ).resolvedModule
        if (resolved !== undefined && isWithin(resolved.resolvedFileName, registration.root)) {
          queue.push(resolved.resolvedFileName)
        }
      }
    }
    return false
  }

  private checkProject(registration: PackageRegistration): void {
    if (this.checkedProjects.has(registration.config.path)) return
    this.checkedProjects.add(registration.config.path)
    const program = ts.createProgram({
      rootNames: registration.config.parsed.fileNames,
      options: {
        ...registration.config.parsed.options,
        composite: false,
        incremental: false,
        noEmit: true,
        // Source-plane workspace aliases resolve referenced packages to source.
        // Widen only this diagnostic program's root so those imports do not
        // produce an artificial TS6059 before Typert checks the public edge.
        rootDir: this.options.root,
      },
    })
    const diagnostics = [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].filter((diagnostic): diagnostic is ts.DiagnosticWithLocation => diagnostic.file !== undefined
      && diagnostic.start !== undefined
      && isWithin(diagnostic.file.fileName, registration.root))
    if (diagnostics.length === 0) return
    throw new TypertAnalysisError(
      diagnostics
        .map(diagnostic => formatProgramDiagnostic(this.options.root, registration.face, diagnostic))
        .join('\n'),
    )
  }

  private queueEdit(edit: SourceEdit): void {
    this.queuedEdit = edit
  }

  private applyEdit(edit: SourceEdit): void {
    const source = readFileSync(edit.file, 'utf8')
    writeFileSync(edit.file, source.slice(0, edit.position) + edit.text + source.slice(edit.position))
    this.caches.invalidate(edit.file)
  }
}

class FaceAnalyzer extends FaceRemoteAnalyzer {
  // eslint-disable-next-line no-useless-constructor -- expose the inherited protected constructor.
  constructor(options: FaceAnalyzerOptions) {
    super(options)
  }

  analyze(): FaceModel {
    for (const registration of this.registrations) {
      this.exportsByPackage.set(registration.name, this.collectExports(registration))
    }
    const packages = this.registrations
      .map(registration => this.analyzePackage(registration))
      .filter(hasPackageSurface)
    this.validateInvocationIdentity(packages)
    return {
      face: this.face,
      packages,
      graph: {
        declarations: [...this.declarations.values()].sort((left, right) => left.id.localeCompare(right.id)),
        nodes: [...this.nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      },
    }
  }

  private analyzePackage(registration: PackageRegistration): PackageModel {
    const records = this.exportsByPackage.get(registration.name) as ExportRecord[]
    const reachable = this.reachableFiles(registration, records.map(record => record.sourceFile))
    const services: ServiceModel[] = []
    const events: EventModel[] = []

    for (const sourceFile of reachable) {
      for (const statement of sourceFile.statements) {
        if (!ts.isModuleDeclaration(statement)
          || !ts.isStringLiteral(statement.name)
          || statement.name.text !== '@deepseek-ai/cordis'
          || statement.body === undefined
          || !ts.isModuleBlock(statement.body)) continue
        for (const member of statement.body.statements) {
          if (!ts.isInterfaceDeclaration(member)) continue
          if (member.name.text === 'Context') {
            services.push(...this.collectServices(member, records))
          } else if (member.name.text === 'Events') {
            events.push(...this.collectEvents(member))
          }
        }
      }
    }
    const explicitServices = this.collectExplicitServices(records)

    const objects: ObjectModel[] = []
    const schemas: SchemaModel[] = []
    const seenBusinessSymbols = new Set<SymbolId>()
    for (const record of records) {
      const declaration = record.declaration
      if (!isTypeDeclaration(declaration)) continue
      if (this.registrationForFile(declaration.getSourceFile().fileName) === undefined) continue
      const symbol = this.resolveSymbol(record.symbol)
      const symbolId = this.symbolId(symbol)
      if (seenBusinessSymbols.has(symbolId)) continue
      const mode = typertMode(declaration)
      if (mode !== 'object' && mode !== 'schema') continue
      seenBusinessSymbols.add(symbolId)
      this.ensureDeclaration(symbol, declaration)
      const documentation = documentationOf(declaration)
      if (mode === 'object') {
        objects.push({
          ...documentation,
          export: record.model,
          symbol: symbolId,
          passing: 'reference',
        })
      } else {
        schemas.push({
          ...documentation,
          export: record.model,
          symbol: symbolId,
          type: this.referenceNode(symbol, declaration),
        })
      }
    }

    return {
      name: registration.name,
      root: slash(relative(this.root, registration.root)),
      exports: records.map(record => record.model)
        .sort((left, right) => left.subpath.localeCompare(right.subpath) || left.name.localeCompare(right.name)),
      services: uniqueBy([...explicitServices, ...services], service => service.key)
        .sort((left, right) => left.key.localeCompare(right.key)),
      events: uniqueBy(events, event => event.name).sort((left, right) => left.name.localeCompare(right.name)),
      objects: objects.sort((left, right) => left.export.name.localeCompare(right.export.name)),
      schemas: schemas.sort((left, right) => left.export.name.localeCompare(right.export.name)),
      invocations: this.face === 'host'
        ? this.collectInvocations(registration, reachable).sort((left, right) => left.id.localeCompare(right.id))
        : [],
    }
  }

  private collectExports(registration: PackageRegistration): ExportRecord[] {
    const targets = packageExportTargets(registration.manifest)
      .filter(([subpath]) => registration.exportSubpaths === undefined
        || registration.exportSubpaths.includes(subpath))
    const records: ExportRecord[] = []
    for (const [subpath, target] of targets) {
      if (target.includes('*') || subpath === './package.json'
        || subpath === './typert' || subpath === './client/typert' || subpath === './remote'
        // Data exports (bundle patch lists, JSON manifests) carry no TypeScript API.
        || target.endsWith('.json') || target.endsWith('.yml') || target.endsWith('.yaml')) continue
      const sourcePath = sourcePathForExport(registration.root, target)
      const sourceFile = this.sourceFiles.get(realPath(sourcePath))
      if (sourceFile === undefined) {
        throw new TypertAnalysisError(
          `typert(${this.face}): ${registration.name} export ${subpath} resolves to missing source ${sourcePath}`,
        )
      }
      const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile)
      if (moduleSymbol === undefined) continue
      for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
        const symbol = this.resolveSymbol(exported)
        const declaration = preferredDeclaration(symbol) as ts.Declaration
        const aliases = exported === symbol || exported.name === symbol.name
          ? [exported.name]
          : [exported.name, symbol.name]
        records.push({
          model: {
            subpath,
            name: exported.name,
            symbol: this.symbolId(symbol),
            aliases,
          },
          symbol,
          declaration,
          sourceFile,
        })
      }
    }
    const unique = uniqueBy(records, record => `${record.model.subpath}\0${record.model.name}`)
    this.collectCrossFaceReExports(registration, unique)
    return unique
  }

  private collectCrossFaceReExports(
    registration: PackageRegistration,
    records: readonly ExportRecord[],
  ): void {
    const publicSymbols = new Set(records.map(record => record.symbol))
    const entryFiles = uniqueBy(records, record => record.sourceFile.fileName).map(record => record.sourceFile)
    for (const sourceFile of this.reachableFiles(registration, entryFiles)) {
      for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement)
          || statement.moduleSpecifier === undefined
          || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const module = moduleIdentity(statement.moduleSpecifier.text)
        if (module === undefined) continue
        const toFace = this.allRegistrations
          .find(candidate => candidate.name === module.package && candidate.face !== this.face)?.face
        if (toFace === undefined) continue

        if (statement.exportClause !== undefined && ts.isNamespaceExport(statement.exportClause)) {
          const namespace = this.resolveSymbol(
            this.checker.getSymbolAtLocation(statement.exportClause.name) as ts.Symbol,
          )
          if (publicSymbols.has(namespace)) {
            this.fail(statement.exportClause, 'cross-face namespace re-exports are not supported')
          }
          continue
        }

        const exports = statement.exportClause === undefined
          ? this.moduleExports(statement.moduleSpecifier)
            .map(symbol => ({ symbol: this.resolveSymbol(symbol), requestedName: symbol.name, site: statement }))
          : statement.exportClause.elements.map(element => ({
            symbol: this.resolveSymbol(this.checker.getSymbolAtLocation(element.name) as ts.Symbol),
            requestedName: element.propertyName?.text ?? element.name.text,
            site: element,
          }))
        for (const exported of exports) {
          if (!publicSymbols.has(exported.symbol)) continue
          const name = this.packageExportName(module, exported.symbol, toFace, exported.requestedName)
          if (name === undefined) {
            this.fail(
              exported.site,
              `cross-face re-export ${exported.requestedName} is not exported by ${module.package} at ${module.subpath}`,
            )
          }
          this.recordCrossFaceLink(registration.name, toFace, module, name)
        }
      }
    }
  }

  private moduleExports(moduleSpecifier: ts.StringLiteral): ts.Symbol[] {
    /* v8 ignore next -- a semantically valid export declaration from a resolved module always has a module symbol. */
    const moduleSymbol = this.checker.getSymbolAtLocation(moduleSpecifier) as ts.Symbol
    return this.checker.getExportsOfModule(moduleSymbol)
  }

  private reachableFiles(
    registration: PackageRegistration,
    entryFiles: readonly ts.SourceFile[],
  ): ts.SourceFile[] {
    const reachable = new Map<string, ts.SourceFile>()
    const queue = [...entryFiles]
    while (queue.length > 0) {
      const sourceFile = queue.shift() as ts.SourceFile
      const fileName = realPath(sourceFile.fileName)
      if (reachable.has(fileName) || !isWithin(fileName, registration.root)) continue
      reachable.set(fileName, sourceFile)
      for (const statement of sourceFile.statements) {
        if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
          || statement.moduleSpecifier === undefined
          || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const resolved = ts.resolveModuleName(
          statement.moduleSpecifier.text,
          sourceFile.fileName,
          this.program.getCompilerOptions(),
          ts.sys,
        ).resolvedModule
        if (resolved === undefined) continue
        const resolvedPath = realPath(resolved.resolvedFileName)
        if (!isWithin(resolvedPath, registration.root)) continue
        queue.push(this.sourceFiles.get(resolvedPath) as ts.SourceFile)
      }
    }
    return [...reachable.values()].sort((left, right) => left.fileName.localeCompare(right.fileName))
  }

  private collectServices(
    context: ts.InterfaceDeclaration,
    records: readonly ExportRecord[],
  ): ServiceModel[] {
    const bySymbol = new Map<SymbolId, ExportRecord[]>()
    for (const record of records) {
      const id = this.symbolId(record.symbol)
      const matches = bySymbol.get(id) ?? []
      matches.push(record)
      bySymbol.set(id, matches)
    }
    const result: ServiceModel[] = []
    for (const member of context.members) {
      if (!ts.isPropertySignature(member) || member.type === undefined) continue
      // An OPTIONAL key is not a service: `X | undefined` and `key?: X` both mark
      // a value the launcher or boot code installs before the tree mounts (a root
      // accessor, an environment snapshot), which no plugin provides and no
      // consumer can reach with `inject`. Describing one as a service would answer
      // "add the plugin that provides it" for a key where no such plugin exists.
      if (member.questionToken !== undefined
        || (ts.isUnionTypeNode(member.type)
          && member.type.types.some(node => node.kind === ts.SyntaxKind.UndefinedKeyword))) continue
      const authoredSymbol = this.symbolAtType(member.type)
      if (authoredSymbol === undefined) continue
      const authoredSymbolId = this.symbolId(authoredSymbol)
      const exported = bySymbol.get(authoredSymbolId)?.find(record => record.model.name === authoredSymbol.name)
        ?? bySymbol.get(authoredSymbolId)?.find(record => record.model.name !== 'default')
        ?? bySymbol.get(authoredSymbolId)?.[0]
      if (exported === undefined) continue
      let symbol = authoredSymbol
      let declaration = preferredDeclaration(symbol)
      const aliases = new Set<ts.Symbol>()
      while (declaration !== undefined && ts.isTypeAliasDeclaration(declaration)) {
        if (aliases.has(symbol)) break
        aliases.add(symbol)
        const target = this.symbolAtType(declaration.type)
        if (target === undefined) break
        symbol = target
        declaration = preferredDeclaration(symbol)
      }
      if (declaration === undefined || (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration))) {
        this.fail(member, `service ${memberName(member.name)} does not resolve to an exported class or interface`)
      }
      const memberOwner = this.registrationForFile(member.getSourceFile().fileName)
      const declarationOwner = this.registrationForFile(declaration.getSourceFile().fileName)
      if (memberOwner?.name !== declarationOwner?.name) continue
      const symbolId = this.symbolId(symbol)
      const model = this.ensureDeclaration(symbol, declaration)
      const exposed = model.members
        .filter(exposableMember)
        .map(publicMember => publicMember.id)
      result.push({
        ...documentationOf(declaration),
        key: memberName(member.name),
        symbol: symbolId,
        export: exported.model,
        members: exposed,
        location: this.location(member),
      })
    }
    return result
  }

  private collectExplicitServices(records: readonly ExportRecord[]): ServiceModel[] {
    const result: ServiceModel[] = []
    const seen = new Set<SymbolId>()
    for (const record of records) {
      const tag = typertServiceTag(record.declaration)
      if (tag === undefined) continue
      const words = (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/)
      if (words.length !== 2 || !isRemoteSegment(words[1] ?? '')) {
        this.fail(tag, '@typert service requires exactly one nonempty Cordis service key without "/"')
      }
      if (!ts.isClassDeclaration(record.declaration)) {
        this.fail(record.declaration, '@typert service requires an exported class')
      }
      const symbol = this.resolveSymbol(record.symbol)
      const symbolId = this.symbolId(symbol)
      if (seen.has(symbolId)) continue
      seen.add(symbolId)
      const model = this.ensureDeclaration(symbol, record.declaration)
      result.push({
        ...documentationOf(record.declaration),
        key: words[1] as string,
        symbol: symbolId,
        export: record.model,
        members: model.members.filter(exposableMember).map(member => member.id),
        location: this.location(record.declaration),
      })
    }
    return result
  }

}
