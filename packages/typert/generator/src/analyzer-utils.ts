import { existsSync, realpathSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import type {
  CrossFaceLink,
  DocumentationModel,
  JsDocTagModel,
  KeywordTypeName,
  MemberModel,
  MemberVisibility,
  PackageModel,
  SymbolId,
  TypeDeclarationModel,
  TypeNodeId,
  TypeNodeModel,
  TypertFace,
  WorkspaceModel,
} from './model.ts'
import {
  EMPTY_DOCUMENTATION,
  TypertAnalysisError,
  type ModuleIdentity,
  type ParsedConfig,
  type ReferenceSite,
} from './analysis-internals.ts'

/**
 * Merge independently analyzed workspace selections without duplicating graph identities.
 * @param models - Workspace models to combine.
 * @returns One deterministically ordered workspace model.
 */
export function mergeWorkspaceModels(models: readonly WorkspaceModel[]): WorkspaceModel {
  const faces = new Map<TypertFace, {
    packages: Map<string, PackageModel>
    declarations: Map<SymbolId, TypeDeclarationModel>
    nodes: Map<TypeNodeId, TypeNodeModel>
  }>()
  const links = new Map<string, CrossFaceLink>()
  for (const model of models) {
    for (const face of model.faces) {
      const merged = faces.get(face.face) ?? {
        packages: new Map(),
        declarations: new Map(),
        nodes: new Map(),
      }
      for (const packageModel of face.packages) merged.packages.set(packageModel.name, packageModel)
      for (const declaration of face.graph.declarations) {
        if (!merged.declarations.has(declaration.id)) merged.declarations.set(declaration.id, declaration)
      }
      for (const node of face.graph.nodes) {
        if (!merged.nodes.has(node.id)) merged.nodes.set(node.id, node)
      }
      faces.set(face.face, merged)
    }
    for (const link of model.crossFaceLinks) {
      links.set([
        link.fromFace,
        link.fromPackage,
        link.toFace,
        link.toPackage,
        link.subpath,
        link.name,
      ].join('\0'), link)
    }
  }
  return {
    faces: [...faces].sort(([left], [right]) =>
      (left === 'host' ? 0 : 1) - (right === 'host' ? 0 : 1)).map(([face, model]) => ({
      face,
      packages: [...model.packages.values()].sort((left, right) => left.name.localeCompare(right.name)),
      graph: {
        declarations: [...model.declarations.values()].sort((left, right) => left.id.localeCompare(right.id)),
        nodes: [...model.nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      },
    })),
    crossFaceLinks: [...links.values()].sort(compareCrossFaceLinks),
  }
}

/**
 * Read and parse one TypeScript project configuration.
 * @param path - Configuration file path.
 * @returns Parsed compiler configuration and its source path.
 */
export function parseConfig(path: string): ParsedConfig {
  const compilerPath = path.split(sep).join('/')
  const read = ts.readConfigFile(compilerPath, file => ts.sys.readFile(file))
  if (read.error !== undefined) throw new TypertAnalysisError(formatDiagnostic(read.error))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(compilerPath), undefined, compilerPath)
  if (parsed.errors.length > 0) throw new TypertAnalysisError(parsed.errors.map(formatDiagnostic).join('\n'))
  return { path, parsed }
}

/**
 * Resolve a project directory or explicit JSON file to its configuration path.
 * @param path - Project directory or configuration file.
 * @returns The explicit configuration file path.
 */
export function projectConfigPath(path: string): string {
  if (extname(path) === '.json') return path
  return join(path, 'tsconfig.json')
}

/**
 * Test whether a source file declares any Typert-visible contribution.
 * @param sourceFile - Source file to inspect.
 * @returns Whether the file contributes a service, object, schema, remote, event, or context surface.
 */
export function sourceFileHasSurface(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if ((ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement))
      && (typertMode(statement) !== undefined || typertServiceTag(statement) !== undefined)) return true
    if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (ts.isPropertyDeclaration(member)
          && memberName(member.name) === 'typertRemote'
          && member.initializer !== undefined
          && ts.isCallExpression(member.initializer)
          && expressionName(member.initializer.expression) === 'bindTypertRemote') return true
        for (const decorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
          const expression = ts.isCallExpression(decorator.expression)
            ? decorator.expression.expression
            : decorator.expression
          const name = expressionName(expression)
          if (name === 'Remote' || name === 'RemoteScope') return true
        }
      }
    }
    if (!ts.isModuleDeclaration(statement)
      || !ts.isStringLiteral(statement.name)
      || statement.name.text !== '@deepseek-ai/cordis'
      || statement.body === undefined
      || !ts.isModuleBlock(statement.body)) continue
    if (statement.body.statements.some(member => ts.isInterfaceDeclaration(member)
      && (member.name.text === 'Context' || member.name.text === 'Events')
      && member.members.length > 0)) return true
  }
  return false
}

/**
 * Test whether a package model contains any Typert-visible contribution.
 * @param model - Package model to inspect.
 * @returns Whether at least one public Typert collection is non-empty.
 */
export function hasPackageSurface(model: PackageModel): boolean {
  return model.services.length > 0
    || model.events.length > 0
    || model.objects.length > 0
    || model.schemas.length > 0
    || model.invocations.length > 0
}

/**
 * Test whether a manifest declares a client face with client exports.
 * @param manifest - Package manifest value.
 * @returns Whether both the client marker and client export surface are present.
 */
export function isDualFacePackage(manifest: Record<string, unknown>): boolean {
  const dsh = manifest.dsh
  const client = dsh !== null && typeof dsh === 'object'
    ? (dsh as Record<string, unknown>).client
    : undefined
  return client !== null
    && typeof client === 'object'
    && clientExportSubpaths(manifest).length > 0
}

/**
 * Select host-side export subpaths from one package manifest.
 * @param manifest - Package manifest value.
 * @returns Host export subpaths in manifest order.
 */
export function hostExportSubpaths(manifest: Record<string, unknown>): string[] {
  return packageExportTargets(manifest)
    .map(([subpath]) => subpath)
    .filter(subpath => subpath !== './client'
      && !subpath.startsWith('./client/')
      && subpath !== './remote')
}

/**
 * Select client-side export subpaths from one package manifest.
 * @param manifest - Package manifest value.
 * @returns Client export subpaths in manifest order.
 */
export function clientExportSubpaths(manifest: Record<string, unknown>): string[] {
  return packageExportTargets(manifest)
    .map(([subpath]) => subpath)
    .filter(subpath => subpath === './client' || subpath.startsWith('./client/'))
}

/**
 * Resolve public package subpaths to their first usable artifact target.
 * @param manifest - Package manifest value.
 * @returns Sorted subpath and artifact-target pairs.
 */
export function packageExportTargets(manifest: Record<string, unknown>): [string, string][] {
  const exportsField = manifest.exports
  if (typeof exportsField === 'string') return [['.', exportsField]]
  if (exportsField === null || typeof exportsField !== 'object') {
    const types = manifest.types
    return typeof types === 'string' ? [['.', types]] : []
  }
  if (Array.isArray(exportsField)
    || !Object.keys(exportsField).some(key => key.startsWith('.'))) {
    const target = exportTarget(exportsField)
    return target === undefined ? [] : [['.', target]]
  }
  const result: [string, string][] = []
  for (const [subpath, value] of Object.entries(exportsField as Record<string, unknown>)) {
    if (!subpath.startsWith('.')) continue
    const target = exportTarget(value)
    if (target !== undefined) result.push([subpath, target])
  }
  return result.sort(([left], [right]) => left.localeCompare(right))
}

/**
 * Resolve the first usable string target from a conditional export value.
 * @param value - Export-map value to inspect.
 * @returns The selected target, when present.
 */
export function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = exportTarget(candidate)
      if (target !== undefined) return target
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const conditions = value as Record<string, unknown>
  for (const key of ['types', 'import', 'default']) {
    const target = exportTarget(conditions[key])
    if (target !== undefined) return target
  }
  for (const candidate of Object.values(conditions)) {
    const target = exportTarget(candidate)
    if (target !== undefined) return target
  }
  return undefined
}

/**
 * Map one published artifact target back to its workspace source file.
 * @param packageRoot - Owning package directory.
 * @param target - Published export target.
 * @returns The corresponding source path.
 */
export function sourcePathForExport(packageRoot: string, target: string): string {
  const normalized = target.replace(/^\.\//, '')
  if (normalized.startsWith('lib/types/')) {
    return resolve(packageRoot, 'src', normalized.slice('lib/types/'.length).replace(/\.d\.(?:mts|cts|ts)$/, '.ts'))
  }
  if (normalized.startsWith('lib/')) {
    return resolve(packageRoot, 'src', normalized.slice('lib/'.length).replace(/\.(?:mjs|cjs|js|d\.ts)$/, '.ts'))
  }
  return resolve(packageRoot, normalized)
}

/**
 * Choose the declaration that best represents one compiler symbol.
 * @param symbol - Compiler symbol to resolve.
 * @returns Its preferred type, value, or first declaration.
 */
export function preferredDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
  return symbol.declarations?.find(isTypeDeclaration)
    ?? symbol.valueDeclaration
    ?? symbol.declarations?.[0]
}

/**
 * Read a syntax node's parent without assuming parent pointers were populated.
 * @param node - Syntax node to inspect.
 * @returns Its parent, when available.
 */
export function optionalParent(node: ts.Node): ts.Node | undefined {
  return (node as ts.Node & { readonly parent?: ts.Node }).parent
}

/**
 * Narrow a syntax node to a supported named type declaration.
 * @param node - Syntax node to inspect.
 * @returns Whether it is a class, interface, type alias, or enum declaration.
 */
export function isTypeDeclaration(
  node: ts.Node,
): node is ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration {
  return ts.isClassDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node)
}

/**
 * Read the identifier of one supported named type declaration.
 * @param declaration - Named type declaration.
 * @returns Its authored identifier.
 */
export function declarationName(
  declaration: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
): string {
  return (declaration.name as ts.Identifier).text
}

/**
 * Render one member signature without its implementation body.
 * @param member - Type or class member to render.
 * @returns Normalized one-line signature text.
 */
export function memberText(member: ts.TypeElement | ts.ClassElement): string {
  const sourceFile = member.getSourceFile()
  const full = member.getText(sourceFile)
  const body = (member as { body?: ts.Node }).body
  const signature = body === undefined ? full : full.slice(0, full.length - body.getText(sourceFile).length)
  return signature.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
}

/**
 * Render one supported declaration without executable class bodies.
 * @param declaration - Type declaration to render.
 * @returns Stable declaration text.
 */
export function declarationText(
  declaration: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
): string {
  const printer = ts.createPrinter({ removeComments: true })
  const projected = ts.isClassDeclaration(declaration) ? classShape(declaration) : declaration
  return printer.printNode(ts.EmitHint.Unspecified, projected, declaration.getSourceFile()).replace(/\r/g, '')
}

/**
 * Project a class declaration to its public, implementation-free syntax.
 * @param node - Class declaration to project.
 * @returns A class declaration containing only public member signatures.
 */
export function classShape(node: ts.ClassDeclaration): ts.ClassDeclaration {
  const nonPublic = (member: ts.ClassElement): boolean =>
    (ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)?.some(modifier =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword) ?? false
  const members = node.members.flatMap((member): ts.ClassElement[] => {
    if (nonPublic(member) || (ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name))) return []
    if (ts.isMethodDeclaration(member)) {
      return [ts.factory.updateMethodDeclaration(
        member,
        member.modifiers,
        member.asteriskToken,
        member.name,
        member.questionToken,
        member.typeParameters,
        member.parameters,
        member.type,
        undefined,
      )]
    }
    if (ts.isConstructorDeclaration(member)) {
      return [ts.factory.updateConstructorDeclaration(member, member.modifiers, member.parameters, undefined)]
    }
    if (ts.isGetAccessorDeclaration(member)) {
      return [ts.factory.updateGetAccessorDeclaration(
        member,
        member.modifiers,
        member.name,
        member.parameters,
        member.type,
        undefined,
      )]
    }
    if (ts.isSetAccessorDeclaration(member)) {
      return [ts.factory.updateSetAccessorDeclaration(
        member,
        member.modifiers,
        member.name,
        member.parameters,
        undefined,
      )]
    }
    if (ts.isPropertyDeclaration(member)) {
      return [ts.factory.updatePropertyDeclaration(
        member,
        member.modifiers,
        member.name,
        member.questionToken ?? member.exclamationToken,
        member.type,
        undefined,
      )]
    }
    return [member]
  })
  return ts.factory.updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    members,
  )
}

/**
 * Project the nearest declaration JSDoc into the compiler-independent model.
 * @param node - Documented syntax node.
 * @returns Normalized description, summary, tags, and raw JSDoc.
 */
export function documentationOf(node: ts.Node): DocumentationModel {
  const blocks = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc)
  const block = blocks.at(-1)
  if (block === undefined) return EMPTY_DOCUMENTATION
  const description = normalizedDocText(ts.getTextOfJSDocComment(block.comment))
  const tags: JsDocTagModel[] = ts.getJSDocTags(node).map((tag) => {
    const named = tag as ts.JSDocTag & { name?: ts.Node }
    const comment = normalizedDocText(ts.getTextOfJSDocComment(tag.comment))
    return {
      name: tag.tagName.text,
      ...(named.name === undefined ? {} : { argument: named.name.getText() }),
      ...(comment === undefined ? {} : { comment }),
      text: tag.getText(tag.getSourceFile()).trim(),
    }
  })
  return {
    ...(description === undefined ? {} : {
      description,
      summary: firstSentence(description),
    }),
    tags,
    jsDoc: rawJsDoc(node),
  }
}

/**
 * Collapse JSDoc whitespace and discard empty content.
 * @param value - Raw JSDoc text.
 * @returns Normalized text, or undefined when empty.
 */
export function normalizedDocText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  /* v8 ignore next -- TypeScript represents whitespace-only JSDoc as undefined before this helper is called. */
  return normalized.length === 0 ? undefined : normalized
}

/**
 * Select a concise summary sentence from normalized prose.
 * @param value - Normalized documentation prose.
 * @returns Its first sentence, or the complete value when unpunctuated.
 */
export function firstSentence(value: string): string {
  return (/^(.*?[.!?])(?:\s|$)/.exec(value)?.[1] ?? value).trim()
}

/**
 * Recover the nearest raw JSDoc block with declaration indentation removed.
 * @param node - Documented syntax node.
 * @returns Raw normalized-indentation JSDoc text.
 */
export function rawJsDoc(node: ts.Node): string {
  const sourceFile = node.getSourceFile()
  const source = sourceFile.getFullText()
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) as ts.CommentRange[]
  const range = ranges.filter(candidate => source.slice(candidate.pos, candidate.pos + 3) === '/**').at(-1) as ts.CommentRange
  const raw = source.slice(range.pos, range.end)
  const { line } = sourceFile.getLineAndCharacterOfPosition(range.pos)
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0)
  const indent = source.slice(lineStart, range.pos)
  return raw.split('\n')
    .map((text, index) => index > 0 && text.startsWith(indent) ? text.slice(indent.length) : text)
    .join('\n')
}

/**
 * Read the object or schema mode selected by a declaration's Typert tag.
 * @param node - Tagged declaration.
 * @returns The selected mode, or undefined when the declaration is untagged.
 */
export function typertMode(node: ts.Node): 'object' | 'schema' | undefined {
  for (const tag of ts.getJSDocTags(node)) {
    if (tag.tagName.text !== 'typert') continue
    const mode = (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/, 1)[0]
    if (mode === 'object') return 'object'
    if (mode === '' || mode === 'schema' || mode === 'type') return 'schema'
  }
  return undefined
}

/**
 * Find a declaration's service-mode Typert tag.
 * @param node - Tagged declaration.
 * @returns The service tag, when present.
 */
export function typertServiceTag(node: ts.Node): ts.JSDocTag | undefined {
  return ts.getJSDocTags(node).find(tag => tag.tagName.text === 'typert'
    && (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/, 1)[0] === 'service')
}

/**
 * Render a property or binding name as a stable model key.
 * @param name - Syntax name to render.
 * @returns Its textual name.
 */
export function memberName(name: ts.PropertyName | ts.BindingName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) return `[${name.expression.getText()}]`
  return name.getText()
}

/**
 * Read a string or no-substitution template literal value.
 * @param node - Candidate literal syntax.
 * @returns The literal value, when supported.
 */
export function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

/**
 * Validate one Typert remote export path segment during bootstrap generation.
 * @param value - Candidate segment.
 * @returns Whether it is a non-relative portable segment.
 */
export function isRemoteSegment(value: string): boolean {
  // Generation bootstraps workspace artifacts before dsh-typert-protocol is built,
  // so this extraction-only copy must mirror isTypertRemoteSegment().
  return value !== '.' && value !== '..' && /^[A-Za-z0-9_$.-]+$/.test(value)
}

/**
 * Read the terminal identifier from an identifier or property-access expression.
 * @param node - Expression to inspect.
 * @returns Its terminal identifier, when supported.
 */
export function expressionName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

/**
 * Join a package name and package export subpath as an import specifier.
 * @param packageName - Bare package name.
 * @param subpath - Manifest export subpath.
 * @returns The public import specifier.
 */
export function packageExportSpecifier(packageName: string, subpath: string): string {
  return subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`
}

/**
 * Resolve authored TypeScript member visibility.
 * @param node - Declaration node to inspect.
 * @returns Public, protected, or private visibility.
 */
export function visibilityOf(node: ts.Node): MemberVisibility {
  if ('name' in node && node.name !== undefined && ts.isPrivateIdentifier(node.name as ts.Node)) return 'private'
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private'
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected'
  return 'public'
}

/**
 * Test whether a syntax node carries one modifier kind.
 * @param node - Syntax node to inspect.
 * @param kind - Modifier kind to match.
 * @returns Whether the modifier is present.
 */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(modifier => modifier.kind === kind) ?? false
}

/**
 * Test whether one modeled member belongs on a public instance surface.
 * @param member - Member model to inspect.
 * @returns Whether it is public and non-static.
 */
export function exposableMember(member: MemberModel): boolean {
  return member.visibility === 'public' && !member.static
}

/**
 * Map a TypeScript keyword syntax kind to the Typert keyword model.
 * @param kind - Syntax kind to classify.
 * @returns The keyword name, when supported.
 */
export function keywordName(kind: ts.SyntaxKind): KeywordTypeName | undefined {
  switch (kind) {
    case ts.SyntaxKind.AnyKeyword: return 'any'
    case ts.SyntaxKind.BigIntKeyword: return 'bigint'
    case ts.SyntaxKind.BooleanKeyword: return 'boolean'
    case ts.SyntaxKind.NeverKeyword: return 'never'
    case ts.SyntaxKind.NumberKeyword: return 'number'
    case ts.SyntaxKind.ObjectKeyword: return 'object'
    case ts.SyntaxKind.StringKeyword: return 'string'
    case ts.SyntaxKind.SymbolKeyword: return 'symbol'
    case ts.SyntaxKind.UndefinedKeyword: return 'undefined'
    case ts.SyntaxKind.UnknownKeyword: return 'unknown'
    case ts.SyntaxKind.VoidKeyword: return 'void'
    default: return undefined
  }
}

/**
 * Project a TypeScript literal type into a Typert literal payload.
 * @param node - Literal type node to convert.
 * @returns The literal payload before identity assignment.
 */
export function literalModel(node: ts.LiteralTypeNode): Omit<Extract<TypeNodeModel, { kind: 'literal' }>, 'id'> {
  const literal = node.literal
  if (ts.isStringLiteral(literal)) return { kind: 'literal', value: literal.text, text: literal.getText() }
  if (ts.isNoSubstitutionTemplateLiteral(literal)) {
    return { kind: 'literal', value: literal.text, text: literal.getText() }
  }
  if (ts.isNumericLiteral(literal)) return { kind: 'literal', value: Number(literal.text), text: literal.getText() }
  if (ts.isBigIntLiteral(literal)) return { kind: 'literal', value: BigInt(literal.text.slice(0, -1)), text: literal.getText() }
  if (literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true, text: 'true' }
  if (literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false, text: 'false' }
  if (literal.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null, text: 'null' }
  /* v8 ignore else -- all remaining LiteralTypeNode syntax is a signed numeric or bigint literal. */
  if (ts.isPrefixUnaryExpression(literal)
    && (ts.isNumericLiteral(literal.operand) || ts.isBigIntLiteral(literal.operand))) {
    return {
      kind: 'literal',
      value: ts.isBigIntLiteral(literal.operand)
        ? BigInt(literal.getText().slice(0, -1))
        : Number(literal.getText()),
      text: literal.getText(),
    }
  }
  /* v8 ignore next -- TypeScript's LiteralTypeNode grammar is exhausted above; this contains future compiler syntax. */
  throw new TypertAnalysisError(`typert: unsupported literal type ${literal.getText()}`)
}

/**
 * Normalize a mapped-type modifier token to its add, remove, or preserve mode.
 * @param token - Authored modifier token.
 * @returns Its normalized operation.
 */
export function modifierMode(token: ts.ReadonlyKeyword | ts.PlusToken | ts.MinusToken | ts.QuestionToken | undefined):
  'add' | 'remove' | 'preserve' {
  if (token?.kind === ts.SyntaxKind.PlusToken) return 'add'
  if (token?.kind === ts.SyntaxKind.MinusToken) return 'remove'
  return token === undefined ? 'preserve' : 'add'
}

/**
 * Locate the insertion point for a missing Typert type annotation.
 * @param node - Property, parameter, or signature node to annotate.
 * @param purpose - Annotation role being inserted.
 * @returns Source position immediately before the annotation text.
 */
export function annotationPosition(
  node: ts.Node,
  purpose: 'property' | 'parameter' | 'return',
): number {
  if (purpose === 'return') return (node as ts.SignatureDeclarationBase).parameters.end + 1
  return (node as ts.ParameterDeclaration | ts.PropertyDeclaration | ts.PropertySignature).name.end
}

/**
 * Recover the authored module specifier for one reference site.
 * @param node - Type, heritage, or import-type reference.
 * @returns Its module specifier, when imported.
 */
export function moduleSpecifierOf(node: ReferenceSite): string | undefined {
  if (ts.isImportTypeNode(node)) {
    const argument = node.argument as ts.LiteralTypeNode & { readonly literal: ts.StringLiteral }
    return argument.literal.text
  }
  const symbol = ts.isTypeReferenceNode(node)
    ? node.typeName
    : node.expression
  const sourceFile = node.getSourceFile()
  const first = ts.isIdentifier(symbol) ? symbol.text : symbol.getFirstToken(sourceFile)?.getText(sourceFile)
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.importClause.name?.text === first) return statement.moduleSpecifier.text
    const bindings = statement.importClause.namedBindings
    if (bindings !== undefined && ts.isNamespaceImport(bindings) && bindings.name.text === first) {
      return statement.moduleSpecifier.text
    }
    if (bindings !== undefined && ts.isNamedImports(bindings)
      && bindings.elements.some(element => element.name.text === first)) return statement.moduleSpecifier.text
  }
  return undefined
}

/**
 * Recover the public export name selected by one imported reference.
 * @param node - Type, heritage, or import-type reference.
 * @param moduleSpecifier - Matching authored module specifier.
 * @returns The referenced package export name.
 */
export function authoredExportName(node: ReferenceSite, moduleSpecifier: string): string {
  if (ts.isImportTypeNode(node)) return (node.qualifier as ts.EntityName).getText().split('.')[0] as string

  const referenced = ts.isTypeReferenceNode(node)
    ? node.typeName.getText().split('.')
    : node.expression.getText().split('.')
  const localName = referenced[0] as string
  for (const statement of node.getSourceFile().statements) {
    if (!ts.isImportDeclaration(statement)
      || statement.importClause === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier) continue
    if (statement.importClause.name?.text === localName) return 'default'
    const bindings = statement.importClause.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      const imported = bindings.elements.find(element => element.name.text === localName)
      if (imported !== undefined) return imported.propertyName?.text ?? imported.name.text
    }
    if (bindings !== undefined && ts.isNamespaceImport(bindings) && bindings.name.text === localName) {
      return referenced[1] as string
    }
  }
  /* v8 ignore next -- moduleSpecifierOf returns only the matching import inspected by this loop. */
  throw new TypertAnalysisError(`typert: cannot recover export name for ${localName} from ${moduleSpecifier}`)
}

/**
 * Preserve the attributes clause authored inside an import type.
 * @param node - Import-type node carrying attributes.
 * @returns The attributes source text.
 */
export function importTypeAttributesText(node: ts.ImportTypeNode): string {
  const sourceFile = node.getSourceFile()
  const children = node.getChildren(sourceFile)
  const comma = children.find(child => child.kind === ts.SyntaxKind.CommaToken) as ts.Node
  const close = children.find(child => child.kind === ts.SyntaxKind.CloseParenToken) as ts.Node
  return sourceFile.text.slice(comma.end, close.pos).trim()
}

/**
 * Parse a bare module specifier into package and export-subpath identity.
 * @param specifier - Authored module specifier.
 * @returns Parsed identity, or undefined for relative and absolute paths.
 */
export function moduleIdentity(specifier: string): ModuleIdentity | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined
  const parts = specifier.split('/')
  const packageLength = specifier.startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, packageLength).join('/')
  const rest = parts.slice(packageLength).join('/')
  return {
    package: packageName,
    subpath: rest.length === 0 ? '.' : `./${rest}`,
  }
}

/**
 * Recover the package identity owning one node_modules file.
 * @param file - Compiler source-file path.
 * @returns Its package root identity, when external.
 */
export function externalModuleIdentityForFile(file: string): ModuleIdentity | undefined {
  const normalized = slash(file)
  const marker = '/node_modules/'
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return undefined
  const parts = normalized.slice(index + marker.length).split('/')
  const packageLength = (parts[0] as string).startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, packageLength).join('/')
  return { package: packageName, subpath: '.' }
}

/**
 * Test whether a file belongs to TypeScript's bundled standard library.
 * @param file - Compiler source-file path.
 * @returns Whether it is a lib.*.d.ts file from TypeScript.
 */
export function isStandardLibraryFile(file: string): boolean {
  const base = file.replaceAll('\\', '/')
  return /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(base)
}

/**
 * Flatten a TypeScript diagnostic message without source coordinates.
 * @param diagnostic - Compiler diagnostic to format.
 * @returns Its message text.
 */
export function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

/**
 * Format a source diagnostic with Typert face and workspace-relative location.
 * @param root - Workspace root used for relative paths.
 * @param face - Host or client analysis face.
 * @param diagnostic - Located compiler diagnostic.
 * @returns One source-oriented diagnostic line.
 */
export function formatProgramDiagnostic(root: string, face: TypertFace, diagnostic: ts.DiagnosticWithLocation): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  const file = slash(relative(root, diagnostic.file.fileName))
  return `typert(${face}): ${file}:${String(position.line + 1)}:${String(position.character + 1)}: TypeScript TS${String(diagnostic.code)}: ${message}`
}

const realPathCache = new Map<string, string>()

/**
 * Resolve an existing path to its cached canonical filesystem spelling.
 * @param path - Path to canonicalize.
 * @returns Canonical absolute path, or the absolute spelling when absent.
 */
export function realPath(path: string): string {
  const absolute = resolve(path)
  const cached = realPathCache.get(absolute)
  if (cached !== undefined) return cached
  // Only existing paths are memoized: a path can come into existence later,
  // but an existing path's canonical form is stable for the process lifetime
  // (analysis edits rewrite file contents, never the directory tree).
  if (!existsSync(absolute)) return absolute
  const resolved = realpathSync(absolute)
  realPathCache.set(absolute, resolved)
  return resolved
}

/**
 * Test whether one canonical path is equal to or nested under another.
 * @param path - Candidate path.
 * @param root - Expected ancestor.
 * @returns Whether the candidate stays within the ancestor.
 */
export function isWithin(path: string, root: string): boolean {
  const absolute = realPath(path)
  const parent = realPath(root)
  return absolute === parent || absolute.startsWith(parent + sep)
}

/**
 * Normalize Windows separators for stable model output.
 * @param value - Filesystem path text.
 * @returns Forward-slash path text.
 */
export function slash(value: string): string {
  return value.replaceAll('\\', '/')
}

/**
 * Keep the first value for every derived string key.
 * @param values - Values to deduplicate.
 * @param key - Stable key selector.
 * @returns First-seen values in input order.
 */
export function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>()
  for (const value of values) if (!result.has(key(value))) result.set(key(value), value)
  return [...result.values()]
}

/**
 * Compare cross-face links using their stable serialized field order.
 * @param left - First link.
 * @param right - Second link.
 * @returns A sort comparator result.
 */
export function compareCrossFaceLinks(left: CrossFaceLink, right: CrossFaceLink): number {
  return left.fromFace.localeCompare(right.fromFace)
    || left.fromPackage.localeCompare(right.fromPackage)
    || left.toFace.localeCompare(right.toFace)
    || left.toPackage.localeCompare(right.toPackage)
    || left.subpath.localeCompare(right.subpath)
    || left.name.localeCompare(right.name)
}
