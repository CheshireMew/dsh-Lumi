import ts from 'typescript'
import type {
  MemberModel,
  RemoteBoundaryModel,
  RemoteTypeImportModel,
  SymbolId,
  TypeNodeId,
} from './model.ts'
import {
  EMPTY_DOCUMENTATION,
  type TypeNodeInput,
} from './analysis-internals.ts'
import {
  hasModifier,
  isStandardLibraryFile,
  optionalParent,
  packageExportSpecifier,
  packageExportTargets,
  preferredDeclaration,
  realPath,
  sourcePathForExport,
} from './analyzer-utils.ts'
import { FaceGraphAnalyzer } from './face-graph-analyzer.ts'

/** Resolved remote JSON validation and codec graph analysis for one face. */
export abstract class FaceRemoteCodecAnalyzer extends FaceGraphAnalyzer {
  protected remoteBoundary(
    authoredType: ts.TypeNode,
    fallbackTypeSymbol: string,
    requireNamed: boolean,
    topLevelAbsence: 'reject' | 'undefined' | 'undefined-or-void' = 'reject',
    optional = false,
  ): RemoteBoundaryModel {
    const type = this.convertType(authoredType)
    const declaredType = this.checker.getTypeFromTypeNode(authoredType)
    // An optional parameter's authored node carries no `undefined`; the codec
    // still has to accept the omitted wire field the consumer sends.
    const resolvedType = optional
      ? this.checker.getNullableType(declaredType, ts.TypeFlags.Undefined)
      : declaredType
    const codecType = this.resolvedRemoteCodecType(authoredType, resolvedType, topLevelAbsence)
    const acceptsUndefined = topLevelAbsence !== 'reject' && this.includesRemoteAbsence(resolvedType)
    const rootSymbol = this.namedWorkspaceType(authoredType)
    const imports = new Map<SymbolId, RemoteTypeImportModel>()
    const visit = (node: ts.Node): void => {
      if ((ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node))) {
        const symbol = ts.isTypeReferenceNode(node)
          ? this.checker.getSymbolAtLocation(node.typeName)
          : node.qualifier === undefined ? undefined : this.checker.getSymbolAtLocation(node.qualifier)
        if (symbol !== undefined) {
          const resolved = this.resolveSymbol(symbol)
          const declaration = preferredDeclaration(resolved)
          if (declaration !== undefined
            && !isStandardLibraryFile(declaration.getSourceFile().fileName)
            && this.registrationForFile(declaration.getSourceFile().fileName) !== undefined) {
            const imported = this.publicRemoteType(resolved, node)
            imports.set(imported.symbol, imported)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(authoredType)
    if (rootSymbol !== undefined) {
      const imported = this.publicRemoteType(rootSymbol, authoredType)
      return {
        type,
        codecType,
        acceptsUndefined,
        typeSymbol: `${imported.specifier}#${imported.name}`,
        imports: [...imports.values()].sort((left, right) =>
          left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name)),
      }
    }
    if (requireNamed) this.fail(authoredType, 'lookup and Context wire types must be named public types')
    return {
      type,
      codecType,
      acceptsUndefined,
      typeSymbol: fallbackTypeSymbol,
      imports: [...imports.values()].sort((left, right) =>
        left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name)),
    }
  }

  /**
   * Project one authored Remote boundary through the complete face Program.
   * Consumer declarations retain the authored alias, while codecs use this
   * concrete graph so declaration-merged mapped and conditional types are
   * validated without teaching the compiler-independent emitter TypeScript's
   * type evaluator.
   */
  protected resolvedRemoteCodecType(
    authoredType: ts.TypeNode,
    resolvedType: ts.Type,
    topLevelAbsence: 'reject' | 'undefined' | 'undefined-or-void',
  ): TypeNodeId {
    this.assertRemoteJsonType(
      resolvedType,
      authoredType,
      new Set(),
      topLevelAbsence !== 'reject',
      topLevelAbsence === 'undefined-or-void',
    )
    const completed = new Map<ts.Type, TypeNodeId>()
    const active = new Map<ts.Type, TypeNodeId>()
    const recursiveDeclarations = new Map<ts.Type, SymbolId>()
    const convert = (type: ts.Type): TypeNodeId => {
      const cached = completed.get(type)
      if (cached !== undefined) return cached
      const activeId = active.get(type)
      if (activeId !== undefined) {
        if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
          const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
          const elementId = element === undefined ? undefined : active.get(element)
          if (element !== undefined && elementId !== undefined) {
            return this.addNode(authoredType, {
              kind: 'array',
              element: this.resolvedCycleReference(
                element,
                authoredType,
                elementId,
                recursiveDeclarations,
              ),
            })
          }
        }
        return this.resolvedCycleReference(type, authoredType, activeId, recursiveDeclarations)
      }
      const id = this.allocateNodeId(authoredType)
      active.set(type, id)
      try {
        const add = (model: TypeNodeInput): TypeNodeId => {
          this.nodes.set(id, { id, ...model })
          completed.set(type, id)
          return id
        }
        const flags = type.flags
        if ((flags & ts.TypeFlags.Any) !== 0) return add({ kind: 'keyword', name: 'any' })
        if ((flags & ts.TypeFlags.Unknown) !== 0) return add({ kind: 'keyword', name: 'unknown' })
        if ((flags & ts.TypeFlags.Never) !== 0) return add({ kind: 'keyword', name: 'never' })
        if ((flags & ts.TypeFlags.String) !== 0) return add({ kind: 'keyword', name: 'string' })
        if ((flags & ts.TypeFlags.Number) !== 0) return add({ kind: 'keyword', name: 'number' })
        if ((flags & ts.TypeFlags.BigInt) !== 0) return add({ kind: 'keyword', name: 'bigint' })
        if ((flags & ts.TypeFlags.Boolean) !== 0) return add({ kind: 'keyword', name: 'boolean' })
        if ((flags & ts.TypeFlags.ESSymbol) !== 0) return add({ kind: 'keyword', name: 'symbol' })
        if ((flags & ts.TypeFlags.Undefined) !== 0) return add({ kind: 'keyword', name: 'undefined' })
        if ((flags & ts.TypeFlags.Void) !== 0) return add({ kind: 'keyword', name: 'void' })
        if ((flags & ts.TypeFlags.Null) !== 0) return add({ kind: 'literal', value: null, text: 'null' })
        if ((flags & ts.TypeFlags.StringLiteral) !== 0) {
          const value = (type as ts.StringLiteralType).value
          return add({ kind: 'literal', value, text: JSON.stringify(value) })
        }
        if ((flags & ts.TypeFlags.NumberLiteral) !== 0) {
          const value = (type as ts.NumberLiteralType).value
          return add({ kind: 'literal', value, text: String(value) })
        }
        if ((flags & ts.TypeFlags.BigIntLiteral) !== 0) {
          const value = (type as ts.BigIntLiteralType).value
          const text = `${value.negative ? '-' : ''}${value.base10Value}n`
          return add({ kind: 'literal', value: BigInt(`${value.negative ? '-' : ''}${value.base10Value}`), text })
        }
        if ((flags & ts.TypeFlags.BooleanLiteral) !== 0) {
          const value = (type as ts.Type & { readonly intrinsicName?: string }).intrinsicName === 'true'
          return add({ kind: 'literal', value, text: String(value) })
        }
        if (type.isUnionOrIntersection()) {
          return add({
            kind: (flags & ts.TypeFlags.Union) !== 0 ? 'union' : 'intersection',
            types: type.types.map(convert),
          })
        }
        if ((flags & ts.TypeFlags.TypeParameter) !== 0) {
          this.fail(authoredType, 'Remote codec contains an unresolved type parameter')
        }
        if ((flags & ts.TypeFlags.Object) === 0) {
          this.fail(
            authoredType,
            `Remote codec type ${this.checker.typeToString(type, authoredType, ts.TypeFormatFlags.NoTruncation)} has no concrete Zod projection`,
          )
        }
        if (this.checker.isTupleType(type)) {
          const reference = type as ts.TypeReference
          const target = reference.target as ts.TupleType
          const arguments_ = this.checker.getTypeArguments(reference)
          return add({
            kind: 'tuple',
            elements: arguments_.map((argument, index) => {
              const elementFlags = target.elementFlags[index] ?? ts.ElementFlags.Required
              return {
                type: convert(argument),
                optional: (elementFlags & ts.ElementFlags.Optional) !== 0,
                rest: (elementFlags & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0,
              }
            }),
          })
        }
        if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
          const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
          if (element === undefined) this.fail(authoredType, 'Remote codec array has no element type')
          return add({ kind: 'array', element: convert(element) })
        }
        if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
          this.fail(authoredType, 'Remote codec cannot contain callable or constructable values')
        }
        const members: MemberModel[] = []
        for (const property of this.checker.getPropertiesOfType(type)) {
          const declaration = property.valueDeclaration ?? property.declarations?.[0]
          const propertyType = this.checker.getTypeOfSymbolAtLocation(property, declaration ?? authoredType)
          const symbolKey = property.getName()
          members.push({
            ...EMPTY_DOCUMENTATION,
            id: `${id}#${symbolKey}`,
            name: symbolKey,
            ...(symbolKey.startsWith('__@') ? { computed: 'symbol' as const } : {}),
            optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
            readonly: declaration !== undefined && hasModifier(declaration, ts.SyntaxKind.ReadonlyKeyword),
            async: false,
            abstract: false,
            static: false,
            visibility: 'public',
            location: this.location(authoredType),
            text: '',
            kind: 'property',
            type: convert(propertyType),
          })
        }
        for (const [index, info] of this.checker.getIndexInfosOfType(type).entries()) {
          members.push({
            ...EMPTY_DOCUMENTATION,
            id: `${id}#index:${String(index)}`,
            name: '(index)',
            optional: false,
            readonly: info.isReadonly,
            async: false,
            abstract: false,
            static: false,
            visibility: 'public',
            location: this.location(authoredType),
            text: '',
            kind: 'index',
            signature: {
              typeParameters: [],
              parameters: [{
                name: 'key',
                binding: 'identifier',
                type: convert(info.keyType),
                optional: false,
                rest: false,
                receiver: false,
              }],
              returns: convert(info.type),
            },
          })
        }
        return add({ kind: 'object', members })
      } finally {
        active.delete(type)
      }
    }
    return convert(resolvedType)
  }

  protected assertRemoteJsonType(
    type: ts.Type,
    site: ts.TypeNode,
    active: Set<ts.Type>,
    allowUndefined: boolean,
    allowVoid: boolean,
  ): void {
    const flags = type.flags
    if ((flags & ts.TypeFlags.Undefined) !== 0 && allowUndefined) return
    if ((flags & ts.TypeFlags.Void) !== 0 && allowVoid) return
    if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      this.fail(site, `Remote boundary contains unconstrained ${this.checker.typeToString(type)} data`)
    }
    if ((flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) {
      this.fail(site, `Remote boundary contains non-JSON type ${this.checker.typeToString(type)}`)
    }
    if ((flags & (ts.TypeFlags.StringLike
      | ts.TypeFlags.NumberLike
      | ts.TypeFlags.BooleanLike
      | ts.TypeFlags.Null
      | ts.TypeFlags.Never)) !== 0) return
    if (type.isUnion()) {
      for (const member of type.types) {
        this.assertRemoteJsonType(member, site, active, allowUndefined, allowVoid)
      }
      return
    }
    if (type.isIntersection()) {
      const material = type.types.filter(member => !this.isRemotePhantomConstraint(member))
      if (material.length === 0) this.fail(site, 'Remote boundary contains a symbol-only object')
      for (const member of material) this.assertRemoteJsonType(member, site, active, false, false)
      return
    }
    if ((flags & ts.TypeFlags.TypeParameter) !== 0) {
      this.fail(site, 'Remote boundary contains an unresolved type parameter')
    }
    if ((flags & ts.TypeFlags.Object) === 0) {
      this.fail(site, `Remote boundary contains non-JSON type ${this.checker.typeToString(type)}`)
    }
    const symbol = type.getSymbol()
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (declaration !== undefined && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) {
      this.fail(site, `Remote boundary contains class instance ${symbol?.name ?? this.checker.typeToString(type)}`)
    }
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      this.fail(site, 'Remote boundary contains callable or constructable data')
    }
    if (active.has(type)) return
    active.add(type)
    try {
      if (this.checker.isTupleType(type)) {
        const reference = type as ts.TypeReference
        const target = reference.target as ts.TupleType
        const arguments_ = this.checker.getTypeArguments(reference)
        arguments_.forEach((argument, index) => {
          const elementFlags = target.elementFlags[index] ?? ts.ElementFlags.Required
          this.assertRemoteJsonType(
            argument,
            site,
            active,
            (elementFlags & ts.ElementFlags.Optional) !== 0,
            false,
          )
        })
        return
      }
      if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
        const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
        if (element === undefined) this.fail(site, 'Remote boundary array has no element type')
        this.assertRemoteJsonType(element, site, active, false, false)
        return
      }
      const properties = this.checker.getPropertiesOfType(type)
      if (properties.some(property => property.getName().startsWith('__@'))) {
        this.fail(site, 'Remote boundary contains a symbol-keyed property')
      }
      for (const property of properties) {
        const propertyDeclaration = property.valueDeclaration ?? property.declarations?.[0]
        const propertyType = this.checker.getTypeOfSymbolAtLocation(property, propertyDeclaration ?? site)
        this.assertRemoteJsonType(
          propertyType,
          site,
          active,
          (property.flags & ts.SymbolFlags.Optional) !== 0,
          false,
        )
      }
      for (const info of this.checker.getIndexInfosOfType(type)) {
        if ((info.keyType.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
          this.fail(site, 'Remote boundary contains a symbol index signature')
        }
        this.assertRemoteJsonType(info.type, site, active, false, false)
      }
    } finally {
      active.delete(type)
    }
  }

  protected includesRemoteAbsence(type: ts.Type): boolean {
    if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return true
    return type.isUnion() && type.types.some(member => this.includesRemoteAbsence(member))
  }

  protected isRemotePhantomConstraint(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Unknown) !== 0) return true
    if ((type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Object) === 0) return false
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false
    if (this.checker.getIndexInfosOfType(type).length > 0) return false
    return this.checker.getPropertiesOfType(type).every(property => property.getName().startsWith('__@'))
  }

  protected resolvedCycleReference(
    type: ts.Type,
    site: ts.TypeNode,
    resolvedType: TypeNodeId,
    recursiveDeclarations: Map<ts.Type, SymbolId>,
  ): TypeNodeId {
    const symbol = type.aliasSymbol ?? type.getSymbol()
    if (symbol === undefined) this.fail(site, 'Remote codec contains an unnamed recursive type')
    const resolved = this.resolveSymbol(symbol)
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined || isStandardLibraryFile(declaration.getSourceFile().fileName)) {
      this.fail(site, `Remote codec recursive type ${resolved.name} has no workspace declaration`)
    }
    const owner = this.registrationForFile(declaration.getSourceFile().fileName)
    if (owner === undefined) this.fail(site, `Remote codec recursive type ${resolved.name} is not owned by this face`)
    let id = recursiveDeclarations.get(type)
    if (id === undefined) {
      id = `${this.symbolId(resolved)}#remote-codec:${resolvedType}`
      recursiveDeclarations.set(type, id)
      this.declarations.set(id, {
        ...EMPTY_DOCUMENTATION,
        id,
        package: owner.name,
        name: `${resolved.name}RemoteCodec`,
        kind: 'alias',
        abstract: false,
        exported: false,
        location: this.location(declaration),
        text: '',
        typeParameters: [],
        extends: [],
        implements: [],
        members: [],
        type: resolvedType,
      })
    }
    return this.addNode(site, {
      kind: 'reference',
      name: `${resolved.name}RemoteCodec`,
      target: { kind: 'declaration', symbol: id },
      arguments: [],
    })
  }

  protected namedWorkspaceType(node: ts.TypeNode): ts.Symbol | undefined {
    if (!ts.isTypeReferenceNode(node) && !ts.isImportTypeNode(node)) return undefined
    const symbol = ts.isTypeReferenceNode(node)
      ? this.checker.getSymbolAtLocation(node.typeName)
      : node.qualifier === undefined ? undefined : this.checker.getSymbolAtLocation(node.qualifier)
    if (symbol === undefined) return undefined
    const resolved = this.resolveSymbol(symbol)
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined
      || isStandardLibraryFile(declaration.getSourceFile().fileName)
      || this.registrationForFile(declaration.getSourceFile().fileName) === undefined) return undefined
    return resolved
  }

  protected publicRemoteType(symbol: ts.Symbol, site: ts.Node): RemoteTypeImportModel {
    const declaration = preferredDeclaration(symbol)
    if (declaration === undefined) this.fail(site, `type ${symbol.name} has no declaration`)
    const registration = this.registrationForFile(declaration.getSourceFile().fileName)
    if (registration === undefined) this.fail(site, `type ${symbol.name} is not owned by a workspace package`)
    const candidates: RemoteTypeImportModel[] = []
    for (const [subpath, target] of packageExportTargets(registration.manifest)) {
      if (subpath === '.' || subpath === './package.json' || subpath === './typert'
        || subpath === './client/typert' || subpath === './remote' || target.includes('*')) continue
      const sourceFile = this.sourceFiles.get(realPath(sourcePathForExport(registration.root, target)))
      if (sourceFile === undefined) continue
      const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile)
      if (moduleSymbol === undefined) continue
      for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
        if (this.resolveSymbol(exported) !== symbol) continue
        candidates.push({
          symbol: this.symbolId(symbol),
          specifier: packageExportSpecifier(registration.name, subpath),
          name: exported.name,
        })
      }
    }
    const selected = candidates.sort((left, right) =>
      left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name))[0]
    if (selected === undefined) {
      this.fail(site, `Remote boundary type ${symbol.name} must be exported from a public non-root type subpath`)
    }
    return selected
  }

  protected isWorkspaceClass(symbol: ts.Symbol): boolean {
    const declaration = preferredDeclaration(symbol)
    return declaration !== undefined
      && ts.isClassDeclaration(declaration)
      && this.registrationForFile(declaration.getSourceFile().fileName) !== undefined
  }

  protected isTypeMetaSymbol(node: ts.Node, name: string): boolean {
    const symbol = this.checker.getSymbolAtLocation(node)
    if (symbol === undefined) return false
    const resolved = this.resolveSymbol(symbol)
    if (resolved.name !== name) return false
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined) return false
    const registration = this.registrationForFile(declaration.getSourceFile().fileName)
    if (registration?.name === '@deepseek-ai/dsh-typert-protocol') return true
    for (let current: ts.Node | undefined = declaration; current !== undefined; current = optionalParent(current)) {
      if (ts.isModuleDeclaration(current)
        && ts.isStringLiteral(current.name)
        && current.name.text === '@deepseek-ai/dsh-typert-protocol') return true
    }
    return false
  }
}
