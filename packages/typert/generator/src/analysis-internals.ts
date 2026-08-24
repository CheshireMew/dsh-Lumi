import ts from 'typescript'
import type {
  CrossFaceLink,
  DocumentationModel,
  ExportModel,
  SymbolId,
  TypeDeclarationModel,
  TypeNodeId,
  TypeNodeModel,
  TypertFace,
} from './model.ts'

/** Remove the generated identity from one type-node model variant. */
export type WithoutId<T> = T extends { readonly id: TypeNodeId } ? Omit<T, 'id'> : never
/** Type-node payload accepted before stable identity assignment. */
export type TypeNodeInput = WithoutId<TypeNodeModel>

/** Analysis failure with a source-oriented diagnostic. */
export class TypertAnalysisError extends Error {
  override name = 'TypertAnalysisError'
}

/** Control signal used to restart analysis after write-mode inserted an annotation. */
export class SourceEditQueued extends Error {}

/** Missing-annotation handling at public business boundaries. */
export type AnalysisMode = 'check' | 'write'

/** One parsed tsconfig, memoizable per workspace snapshot. */
export interface ParsedConfig {
  readonly path: string
  readonly parsed: ts.ParsedCommandLine
}

/** One package face registration discovered from an aggregate tsconfig. */
export interface PackageRegistration {
  readonly face: TypertFace
  readonly name: string
  readonly root: string
  readonly config: ParsedConfig
  readonly manifest: Record<string, unknown>
  readonly exportSubpaths?: readonly string[]
}

/** Compiler symbol and source declaration backing one public export model. */
export interface ExportRecord {
  readonly model: ExportModel
  readonly symbol: ts.Symbol
  readonly declaration: ts.Declaration
  readonly sourceFile: ts.SourceFile
}

/** One write-mode annotation insertion requested by analysis. */
export interface SourceEdit {
  readonly file: string
  readonly position: number
  readonly text: string
}

/** Parsed bare-module package identity and export subpath. */
export interface ModuleIdentity {
  readonly package: string
  readonly subpath: string
}

/** Statically declared lookup contribution and its wire type. */
export interface StaticLookupDeclaration {
  readonly key: string
  readonly hostSymbol: SymbolId
  readonly wireType: ts.TypeNode
  readonly site: ts.Node
}

/** Statically declared context property and its wire type. */
export interface StaticContextDeclaration {
  readonly key: string
  readonly wireType: ts.TypeNode
  readonly site: ts.Node
}

/** Service and namespace selected by one remote gateway binding. */
export interface GatewayBinding {
  readonly service: string
  readonly namespace: string
  readonly site: ts.Node
}

/** Syntax forms that can reference a public type across module exports. */
export type ReferenceSite = ts.TypeReferenceNode | ts.ExpressionWithTypeArguments | ts.ImportTypeNode

/** Documentation payload used when a declaration has no JSDoc. */
export const EMPTY_DOCUMENTATION: DocumentationModel = { tags: [] }

/** Immutable inputs used to construct one face analyzer. */
export interface FaceAnalyzerOptions {
  readonly root: string
  readonly face: TypertFace
  readonly program: ts.Program
  readonly registrations: readonly PackageRegistration[]
  readonly allRegistrations: readonly PackageRegistration[]
  readonly mode: AnalysisMode
  readonly queueEdit: (edit: SourceEdit) => void
  readonly crossFaceLinks: Map<string, CrossFaceLink>
}

/** Shared compiler and model state used by the face analyzer layers. */
export interface FaceAnalysisState {
  readonly root: string
  readonly face: TypertFace
  readonly program: ts.Program
  readonly checker: ts.TypeChecker
  readonly registrations: readonly PackageRegistration[]
  readonly allRegistrations: readonly PackageRegistration[]
  readonly mode: AnalysisMode
  readonly queueEdit: (edit: SourceEdit) => void
  readonly crossFaceLinks: Map<string, CrossFaceLink>
  readonly sourceFiles: Map<string, ts.SourceFile>
  readonly declarations: Map<SymbolId, TypeDeclarationModel>
  readonly declarationStates: Set<SymbolId>
  readonly nodes: Map<TypeNodeId, TypeNodeModel>
  readonly exportsByPackage: Map<string, ExportRecord[]>
  readonly nodeOrdinals: Map<string, number>
}
