import {z} from 'zod'

/** Shared identity primitive; resource contracts must not import executable request schemas. */
export const frameworkIdentitySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/)
