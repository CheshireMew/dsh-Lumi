import ts from 'typescript'
import type {
  EventModel,
  InvocationModel,
  InvocationParameterModel,
  PackageModel,
  SymbolId,
} from './model.ts'
import {
  TypertAnalysisError,
  type GatewayBinding,
  type PackageRegistration,
  type StaticContextDeclaration,
  type StaticLookupDeclaration,
} from './analysis-internals.ts'
import {
  documentationOf,
  hasModifier,
  isRemoteSegment,
  isStandardLibraryFile,
  memberName,
  memberText,
  preferredDeclaration,
  stringLiteralValue,
  visibilityOf,
} from './analyzer-utils.ts'
import { FaceRemoteCodecAnalyzer } from './face-remote-codec-analyzer.ts'

/** Remote invocation, codec, event, and identity analysis over one face graph. */
export abstract class FaceRemoteAnalyzer extends FaceRemoteCodecAnalyzer {
  protected collectInvocations(
    registration: PackageRegistration,
    reachable: readonly ts.SourceFile[],
  ): InvocationModel[] {
    const result: InvocationModel[] = []
    for (const sourceFile of reachable) {
      for (const statement of sourceFile.statements) {
        if (!ts.isClassDeclaration(statement)) continue
        const marked = statement.members.flatMap((member) => {
          const invocation = this.remoteMarker(member)
          if (invocation === undefined) return []
          if (!ts.isMethodDeclaration(member)) {
            this.fail(member, 'Remote decorators require a public instance method')
          }
          return [{ method: member, invocation }]
        })
        const first = marked[0]
        if (first === undefined) continue
        const binding = this.gatewayBinding(statement)
        if (binding === undefined) {
          this.fail(
            first.method,
            'Remote methods require TypertRemoteService or readonly typertGateway = bindTypertRemote(this, serviceKey)',
          )
        }
        for (const { method, invocation } of marked) {
          result.push(this.invocationModel(registration, binding, method, invocation))
        }
      }
    }
    return result
  }

  protected invocationModel(
    registration: PackageRegistration,
    binding: GatewayBinding,
    method: ts.MethodDeclaration,
    invocation:
      | { readonly kind: 'direct'; readonly exportName?: string }
      | { readonly kind: 'context'; readonly context: string; readonly exportName?: string },
  ): InvocationModel {
    if (visibilityOf(method) !== 'public' || hasModifier(method, ts.SyntaxKind.StaticKeyword)) {
      this.fail(method, 'Remote decorators require a public instance method')
    }
    if (hasModifier(method, ts.SyntaxKind.AbstractKeyword) || method.body === undefined) {
      this.fail(method, 'Remote methods must have a concrete implementation')
    }
    if (!ts.isIdentifier(method.name)) {
      this.fail(method, 'Remote method names must be identifiers')
    }
    if ((method.typeParameters?.length ?? 0) > 0) {
      this.fail(method, 'generic Remote methods are not supported')
    }
    const methodName = method.name.text
    const exportedMethod = invocation.exportName ?? methodName

    const lookups = this.lookupDeclarations()
    const lookupByHost = new Map(lookups.map(lookup => [lookup.hostSymbol, lookup]))
    const parameters: InvocationParameterModel[] = []
    let cancellation: InvocationModel['cancellation']
    const wires = new Set<string>()
    for (const [parameterIndex, parameter] of method.parameters.entries()) {
      if (!ts.isIdentifier(parameter.name)) {
        this.fail(parameter, 'Remote parameters must use identifier bindings')
      }
      if (parameter.dotDotDotToken !== undefined) this.fail(parameter, 'Remote parameters cannot be rest parameters')
      if (parameter.initializer !== undefined) this.fail(parameter, 'Remote parameters cannot have default values')
      if (parameter.name.text === 'this') this.fail(parameter, 'Remote methods cannot declare an explicit this parameter')
      const optional = parameter.questionToken !== undefined
      const authoredType = this.requiredType(parameter, parameter.type, 'parameter')
      const cancellationName = parameter.name.text === 'signal'
      const cancellationType = this.isGlobalAbortSignal(authoredType)
      if (cancellationName || cancellationType) {
        if (!cancellationName || !cancellationType) {
          this.fail(parameter, 'Remote cancellation must use a parameter named signal with the global AbortSignal type')
        }
        if (parameterIndex !== method.parameters.length - 1) {
          this.fail(parameter, 'Remote cancellation signal must be the final parameter')
        }
        cancellation = { parameter: 'signal' }
        continue
      }
      const hostSymbol = this.symbolAtType(authoredType)
      const lookup = hostSymbol === undefined ? undefined : lookupByHost.get(this.symbolId(hostSymbol))
      let modeled: InvocationParameterModel
      if (lookup !== undefined) {
        if (optional) this.fail(parameter, `lookup parameter for ${lookup.key} cannot be optional`)
        if (parameter.name.text !== lookup.key) {
          this.fail(parameter, `lookup parameter for ${lookup.key} must also be named ${lookup.key}`)
        }
        const boundary = this.remoteBoundary(
          lookup.wireType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:${lookup.key}Id`,
          true,
        )
        modeled = {
          name: parameter.name.text,
          wire: `${lookup.key}Id`,
          source: 'lookup',
          lookup: lookup.key,
          boundary,
        }
      } else {
        if (hostSymbol !== undefined && this.isWorkspaceClass(hostSymbol)) {
          this.fail(parameter, `non-JSON class parameter ${hostSymbol.name} requires a TypertLookupMap entry`)
        }
        modeled = {
          name: parameter.name.text,
          wire: parameter.name.text,
          source: 'json',
          ...optional ? { optional: true as const } : {},
          boundary: this.remoteBoundary(
            authoredType,
            `${registration.name}#${binding.namespace}/${exportedMethod}:${parameter.name.text}`,
            false,
            'undefined',
            optional,
          ),
        }
      }
      if (wires.has(modeled.wire)) this.fail(parameter, `duplicate Remote wire field ${modeled.wire}`)
      wires.add(modeled.wire)
      parameters.push(modeled)
    }

    let receiver: InvocationModel['invocation'] = { kind: 'direct' }
    if (invocation.kind === 'context') {
      const context = this.contextDeclarations().get(invocation.context)
      if (context === undefined) {
        this.fail(method, `Remote Scope ${invocation.context} has no TypertContextMap entry`)
      }
      const wire = `${invocation.context}Id`
      if (wires.has(wire)) this.fail(method, `Remote Scope wire field ${wire} conflicts with a method parameter`)
      receiver = {
        kind: 'context',
        context: invocation.context,
        wire,
        boundary: this.remoteBoundary(
          context.wireType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:${wire}`,
          true,
        ),
      }
    }

    let scope: InvocationModel['scope']
    if (invocation.kind === 'direct') {
      const lookupParameters = parameters.filter(parameter => parameter.source === 'lookup')
      const parameter = lookupParameters.length === 1 ? lookupParameters[0] : undefined
      const context = parameter?.lookup === undefined
        ? undefined
        : this.contextDeclarations().get(parameter.lookup)
      if (parameter !== undefined && context !== undefined) {
        const contextBoundary = this.remoteBoundary(
          context.wireType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:scope:${context.key}`,
          true,
        )
        if (contextBoundary.typeSymbol !== parameter.boundary.typeSymbol) {
          this.fail(
            method,
            `Remote scope ${context.key} wire type ${contextBoundary.typeSymbol} does not match lookup wire type ${parameter.boundary.typeSymbol}`,
          )
        }
        scope = { context: context.key, wire: parameter.wire }
      }
    }

    const resultType = this.remoteResultType(method)
    return {
      id: `${registration.name}#${binding.namespace}/${exportedMethod}`,
      service: binding.service,
      namespace: binding.namespace,
      method: exportedMethod,
      ...(exportedMethod === methodName ? {} : { implementation: methodName }),
      invocation: receiver,
      ...(scope === undefined ? {} : { scope }),
      parameters,
      ...(cancellation === undefined ? {} : { cancellation }),
      result: this.remoteBoundary(
        resultType,
        `${registration.name}#${binding.namespace}/${exportedMethod}:result`,
        false,
        'undefined-or-void',
      ),
      location: this.location(method.name),
    }
  }

  protected gatewayBinding(declaration: ts.ClassDeclaration): GatewayBinding | undefined {
    const field = this.gatewayFieldBinding(declaration)
    const base = this.gatewayServiceBinding(declaration)
    if (field !== undefined && base !== undefined) {
      this.fail(field.site, 'TypertRemoteService subclasses must not declare a second typertRemote binding')
    }
    return field ?? base
  }

  protected gatewayFieldBinding(declaration: ts.ClassDeclaration): GatewayBinding | undefined {
    const candidates = declaration.members.filter((member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && memberName(member.name) === 'typertRemote')
    const [property, duplicate] = candidates
    if (property === undefined) return undefined
    if (duplicate !== undefined) this.fail(duplicate, 'Service has more than one typertGateway field')
    if (visibilityOf(property) !== 'public'
      || hasModifier(property, ts.SyntaxKind.StaticKeyword)
      || !hasModifier(property, ts.SyntaxKind.ReadonlyKeyword)) {
      this.fail(property, 'typertGateway must be a public readonly instance field')
    }
    if (property.initializer === undefined
      || !ts.isCallExpression(property.initializer)
      || !this.isTypeMetaSymbol(property.initializer.expression, 'bindTypertRemote')) {
      this.fail(property, 'typertGateway must call bindTypertRemote()')
    }
    const call = property.initializer
    if (call.arguments.length < 2 || call.arguments.length > 3) {
      this.fail(call, 'bindTypertRemote() requires this, service key, and an optional options object')
    }
    if (call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword) {
      this.fail(call.arguments[0] ?? call, 'bindTypertRemote() first argument must be this')
    }
    return this.gatewayBindingArguments(call, property)
  }

  protected gatewayServiceBinding(declaration: ts.ClassDeclaration): GatewayBinding | undefined {
    const heritage = (declaration.heritageClauses ?? [])
      .filter(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)
      .flatMap(clause => [...clause.types])
      .find(type => this.isTypeMetaSymbol(type.expression, 'TypertRemoteService'))
    if (heritage === undefined) return undefined

    const constructor = declaration.members.find(ts.isConstructorDeclaration)
    if (constructor?.body === undefined) {
      this.fail(heritage, 'TypertRemoteService subclasses must declare a constructor with super(ctx, serviceKey)')
    }
    const call = constructor.body.statements.flatMap((statement) => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return []
      return statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword ? [statement.expression] : []
    })[0]
    if (call === undefined) {
      this.fail(constructor, 'TypertRemoteService constructor must call super(ctx, serviceKey) directly')
    }
    if (call.arguments.length < 2 || call.arguments.length > 3) {
      this.fail(call, 'TypertRemoteService super() requires context, service key, and an optional options object')
    }
    return this.gatewayBindingArguments(call, heritage)
  }

  protected gatewayBindingArguments(call: ts.CallExpression, site: ts.Node): GatewayBinding {
    const serviceArgument = call.arguments[1]
    if (serviceArgument === undefined) this.fail(call, 'Gateway service key must be a string literal')
    const service = stringLiteralValue(serviceArgument)
    if (service === undefined) this.fail(serviceArgument, 'Gateway service key must be a string literal')
    let namespace = service
    const options = call.arguments[2]
    if (options !== undefined) {
      if (!ts.isObjectLiteralExpression(options)) {
        this.fail(options, 'bindTypertRemote() options must be an object literal')
      }
      for (const propertyOption of options.properties) {
        if (!ts.isPropertyAssignment(propertyOption)
          || memberName(propertyOption.name) !== 'namespace') {
          this.fail(propertyOption, 'bindTypertRemote() only supports a namespace option')
        }
        const value = stringLiteralValue(propertyOption.initializer)
        if (value === undefined) this.fail(propertyOption.initializer, 'Gateway namespace must be a string literal')
        namespace = value
      }
    }
    if (!isRemoteSegment(service)) this.fail(serviceArgument, 'Gateway service key must contain only RPC endpoint segment characters')
    if (!isRemoteSegment(namespace)) this.fail(options ?? call, 'Gateway namespace must contain only RPC endpoint segment characters')
    return { service, namespace, site }
  }

  protected remoteMarker(
    member: ts.ClassElement,
  ):
    | { readonly kind: 'direct'; readonly exportName?: string }
    | { readonly kind: 'context'; readonly context: string; readonly exportName?: string }
    | undefined {
    let found:
      | { readonly kind: 'direct'; readonly exportName?: string }
      | { readonly kind: 'context'; readonly context: string; readonly exportName?: string }
      | undefined
    for (const decorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
      const expression = decorator.expression
      let marker: typeof found
      if (this.isTypeMetaSymbol(expression, 'Remote')) {
        marker = { kind: 'direct' }
      } else if (ts.isCallExpression(expression)
        && this.isTypeMetaSymbol(expression.expression, 'Remote')) {
        if (expression.arguments.length !== 1) this.fail(expression, 'Remote() requires one exported method name')
        const exportName = stringLiteralValue(expression.arguments[0])
        if (exportName === undefined || !isRemoteSegment(exportName)) {
          this.fail(expression.arguments[0] ?? expression, 'Remote() name must be a string literal containing only RPC endpoint segment characters')
        }
        marker = { kind: 'direct', exportName }
      } else if (ts.isCallExpression(expression)
        && this.isTypeMetaSymbol(expression.expression, 'RemoteScope')) {
        if (expression.arguments.length < 1 || expression.arguments.length > 2) {
          this.fail(expression, 'RemoteScope() requires a Context key and optional exported method name')
        }
        const context = stringLiteralValue(expression.arguments[0])
        if (context === undefined || !isRemoteSegment(context)) {
          this.fail(expression.arguments[0] ?? expression, 'RemoteScope() key must be a string literal containing only RPC endpoint segment characters')
        }
        const exportArgument = expression.arguments[1]
        const exportName = exportArgument === undefined ? undefined : stringLiteralValue(exportArgument)
        if (exportArgument !== undefined && (exportName === undefined || !isRemoteSegment(exportName))) {
          this.fail(exportArgument, 'RemoteScope() name must be a string literal containing only RPC endpoint segment characters')
        }
        marker = { kind: 'context', context, ...exportName === undefined ? {} : { exportName } }
      } else {
        continue
      }
      if (found !== undefined) this.fail(decorator, 'a method can have only one Remote invocation decorator')
      found = marker
    }
    return found
  }

  protected remoteResultType(method: ts.MethodDeclaration): ts.TypeNode {
    const authored = this.requiredType(method, method.type, 'return')
    if (!ts.isTypeReferenceNode(authored)) return authored
    const symbol = this.checker.getSymbolAtLocation(authored.typeName)
    const resolved = symbol === undefined ? undefined : this.resolveSymbol(symbol)
    const resultType = authored.typeArguments?.[0]
    if (resolved?.name !== 'Promise' || resultType === undefined || authored.typeArguments?.length !== 1) return authored
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined || !isStandardLibraryFile(declaration.getSourceFile().fileName)) return authored
    return resultType
  }

  protected isGlobalAbortSignal(type: ts.TypeNode): boolean {
    const symbol = this.symbolAtType(type)
    if (symbol?.name !== 'AbortSignal') return false
    return symbol.declarations?.some(declaration =>
      isStandardLibraryFile(declaration.getSourceFile().fileName)) === true
  }

  protected lookupDeclarations(): readonly StaticLookupDeclaration[] {
    if (this.staticLookups !== undefined) return this.staticLookups
    const byKey = new Map<string, StaticLookupDeclaration>()
    const byHost = new Map<SymbolId, StaticLookupDeclaration>()
    for (const declaration of this.typeMetaMapMembers('TypertLookupMap')) {
      if (!ts.isPropertySignature(declaration) || declaration.type === undefined) {
        this.fail(declaration, 'TypertLookupMap entries must be required properties')
      }
      const key = memberName(declaration.name)
      if (!isRemoteSegment(key)) this.fail(declaration.name, 'TypertLookupMap key must contain only RPC endpoint segment characters')
      if (!ts.isTypeReferenceNode(declaration.type)
        || !this.isTypeMetaSymbol(declaration.type.typeName, 'TypertLookup')
        || declaration.type.typeArguments?.length !== 2) {
        this.fail(declaration.type, 'TypertLookupMap values must be TypertLookup<Host, Wire>')
      }
      const hostType = declaration.type.typeArguments[0]
      const wireType = declaration.type.typeArguments[1]
      if (hostType === undefined || wireType === undefined) {
        this.fail(declaration.type, 'TypertLookupMap values must be TypertLookup<Host, Wire>')
      }
      const host = this.symbolAtType(hostType)
      if (host === undefined) this.fail(hostType, 'TypertLookup Host must be a named type')
      const entry: StaticLookupDeclaration = {
        key,
        hostSymbol: this.symbolId(host),
        wireType,
        site: declaration,
      }
      if (byKey.has(key)) this.fail(declaration, `duplicate TypertLookupMap key ${key}`)
      if (byHost.has(entry.hostSymbol)) this.fail(declaration, `Host type ${host.name} has more than one Typert lookup`)
      byKey.set(key, entry)
      byHost.set(entry.hostSymbol, entry)
    }
    this.staticLookups = [...byKey.values()]
    return this.staticLookups
  }

  protected contextDeclarations(): ReadonlyMap<string, StaticContextDeclaration> {
    if (this.staticContexts !== undefined) return this.staticContexts
    const result = new Map<string, StaticContextDeclaration>()
    for (const declaration of this.typeMetaMapMembers('TypertContextMap')) {
      if (!ts.isPropertySignature(declaration) || declaration.type === undefined) {
        this.fail(declaration, 'TypertContextMap entries must be required properties')
      }
      const key = memberName(declaration.name)
      if (!isRemoteSegment(key)) this.fail(declaration.name, 'TypertContextMap key must contain only RPC endpoint segment characters')
      if (!ts.isTypeReferenceNode(declaration.type)
        || !this.isTypeMetaSymbol(declaration.type.typeName, 'TypertContext')
        || declaration.type.typeArguments?.length !== 1) {
        this.fail(declaration.type, 'TypertContextMap values must be TypertContext<Wire>')
      }
      if (result.has(key)) this.fail(declaration, `duplicate TypertContextMap key ${key}`)
      const wireType = declaration.type.typeArguments[0]
      if (wireType === undefined) this.fail(declaration.type, 'TypertContextMap values must be TypertContext<Wire>')
      result.set(key, {
        key,
        wireType,
        site: declaration,
      })
    }
    this.staticContexts = result
    return result
  }

  protected typeMetaMapMembers(name: 'TypertLookupMap' | 'TypertContextMap'): ts.TypeElement[] {
    const result: ts.TypeElement[] = []
    for (const sourceFile of this.program.getSourceFiles()) {
      for (const statement of sourceFile.statements) {
        if (!ts.isModuleDeclaration(statement)
          || !ts.isStringLiteral(statement.name)
          || statement.name.text !== '@deepseek-ai/dsh-typert-protocol'
          || statement.body === undefined
          || !ts.isModuleBlock(statement.body)) continue
        for (const nested of statement.body.statements) {
          if (ts.isInterfaceDeclaration(nested) && nested.name.text === name) result.push(...nested.members)
        }
      }
    }
    return result
  }

  protected validateInvocationIdentity(packages: readonly PackageModel[]): void {
    const endpoints = new Map<string, InvocationModel>()
    const ids = new Map<string, InvocationModel>()
    for (const invocation of packages.flatMap(packageModel => packageModel.invocations)) {
      const endpoint = `${invocation.namespace}/${invocation.method}`
      const existingEndpoint = endpoints.get(endpoint)
      if (existingEndpoint !== undefined) {
        throw new TypertAnalysisError(
          `typert(${this.face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote endpoint ${endpoint} conflicts with ${existingEndpoint.id}`,
        )
      }
      const existingId = ids.get(invocation.id)
      if (existingId !== undefined) {
        throw new TypertAnalysisError(
          `typert(${this.face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote invocation id ${invocation.id} conflicts with ${existingId.id}`,
        )
      }
      endpoints.set(endpoint, invocation)
      ids.set(invocation.id, invocation)
    }
  }

  protected collectEvents(events: ts.InterfaceDeclaration): EventModel[] {
    const result: EventModel[] = []
    for (const member of events.members) {
      const documentation = documentationOf(member)
      const mode = documentation.tags.find(tag => tag.name === 'mode')?.comment?.trim()
      if (ts.isMethodSignature(member)) {
        const signature = this.signature(member, member.type)
        result.push({
          ...documentation,
          name: memberName(member.name),
          signature: this.addNode(member, { kind: 'function', signature }),
          text: memberText(member),
          ...(mode === undefined ? {} : { mode }),
          location: this.location(member),
        })
      } else if (ts.isPropertySignature(member) && member.type !== undefined) {
        result.push({
          ...documentation,
          name: memberName(member.name),
          signature: this.convertType(member.type),
          text: memberText(member),
          ...(mode === undefined ? {} : { mode }),
          location: this.location(member),
        })
      }
    }
    return result
  }
}
