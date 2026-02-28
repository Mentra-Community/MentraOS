# 003: CORS Config Extraction

Extract CORS origins list from `index.ts` to a dedicated config file.

## Problem

The CORS origins list in `index.ts` is 80+ lines long and clutters the main entry point.

## Goal

Move CORS origins to `packages/cloud/src/config/cors.ts` for better organization.

## Implementation

### Create `config/cors.ts`

```typescript
export const CORS_ORIGINS = [
  "*",
  "http://localhost:3000",
  // ... all origins from index.ts
]
```

### Update `index.ts`

```typescript
import {CORS_ORIGINS} from "./config/cors"

app.use(
  cors({
    credentials: true,
    origin: CORS_ORIGINS,
  }),
)
```

## Files Changed

| File             | Change                                  |
| ---------------- | --------------------------------------- |
| `config/cors.ts` | New - CORS origins list                 |
| `index.ts`       | Import CORS_ORIGINS, remove inline list |

## Success Criteria

- [ ] CORS origins moved to dedicated file
- [ ] No behavior change
