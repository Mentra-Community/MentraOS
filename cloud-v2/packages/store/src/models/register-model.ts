/**
 * @fileoverview Idempotent mongoose model registration.
 *
 * `model("Name", schema)` throws OverwriteModelError when a model file is
 * evaluated twice in one process — which happens under whole-package
 * `bun test` runs, where different test files can reach the same model
 * through different module identities (relative path vs. package entry, or
 * the package's nested node_modules). Reusing the already-compiled model
 * makes registration idempotent; the first registration wins, so behavior
 * in a normal single-identity process is unchanged.
 */

import {
  model,
  models,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
  type ObtainSchemaGeneric,
  type Schema,
} from "mongoose"

// Return type of mongoose's `model(name, schema)` overload for a concrete
// schema, spelled out because `ReturnType<typeof model<TSchema>>` resolves
// against the wrong overload (doc type collapses to the Schema itself).
type CompiledModel<TSchema extends Schema> = Model<
  InferSchemaType<TSchema>,
  ObtainSchemaGeneric<TSchema, "TQueryHelpers">,
  ObtainSchemaGeneric<TSchema, "TInstanceMethods">,
  ObtainSchemaGeneric<TSchema, "TVirtuals">,
  HydratedDocument<
    InferSchemaType<TSchema>,
    ObtainSchemaGeneric<TSchema, "TVirtuals"> & ObtainSchemaGeneric<TSchema, "TInstanceMethods">,
    ObtainSchemaGeneric<TSchema, "TQueryHelpers">,
    ObtainSchemaGeneric<TSchema, "TVirtuals">,
    ObtainSchemaGeneric<TSchema, "TSchemaOptions">
  >,
  TSchema
> &
  ObtainSchemaGeneric<TSchema, "TStaticMethods">

export function registerModel<TSchema extends Schema>(name: string, schema: TSchema): CompiledModel<TSchema> {
  return (models[name] as CompiledModel<TSchema> | undefined) ?? model(name, schema)
}
