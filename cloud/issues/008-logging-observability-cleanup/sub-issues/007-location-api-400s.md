# Sub-Issue 008.7: Location API 400 Errors

**Status**: Open  
**Priority**: Medium (~6K errors/hr)  
**Component**: location.api.ts, mobile MantleManager

## Problem

`POST /api/client/location` returning 400 errors due to data format mismatch between mobile client and API.

## Error Volume

~6,381 errors per hour from various users.

## Root Cause

**Mobile sends** (MantleManager.ts:34):

```typescript
const first = locs[0]! // Expo Location.LocationObject
restComms.sendLocationData(first)
```

Expo `LocationObject` structure:

```typescript
{
  coords: {
    latitude: number,
    longitude: number,
    accuracy: number,
    // ...
  },
  timestamp: number,
  // ...
}
```

**API expects** (location.api.ts:26-31):

```typescript
const {location} = req.body

if (!location || typeof location !== "object") {
  return res.status(400).json({
    success: false,
    message: "location object required",
  })
}
```

The API expects `req.body.location` but mobile sends the LocationObject directly as `req.body` without the `location` wrapper.

## Fix

**Cloud-side fix** - Accept both formats:

```typescript
// Accept either { location: {...} } or direct Expo LocationObject { coords: {...} }
const location = req.body.location || (req.body.coords ? req.body : null)

if (!location || typeof location !== "object") {
  return res.status(400).json({
    success: false,
    message: "location object required",
  })
}
```

**Mobile-side fix** (for client team):

```typescript
// Wrap the location object
restComms.sendLocationData({location: first})
```

## Files to Modify

- `cloud/packages/cloud/src/api/client/location.api.ts` - Accept both formats

## Notes

- Mobile team should be notified about the format issue
- Cloud fix is backwards compatible - works with both old and new mobile versions
- Consider also normalizing field names (`latitude` → `lat`, `longitude` → `lng`) if LocationManager expects different format

## Success Criteria

- Location API 400 errors drop to near zero
- Both old and new mobile client versions work
