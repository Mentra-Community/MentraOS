import type {PlaceDetails, SavedPlace, SavedPlaceType} from "../lib/places"

const SAVED_ADDRESS_TYPES = ["home", "work"] as const

type SavedAddressStorage = {
  getAllSavedPlaces(): Promise<SavedPlace[]>
  addSavedPlace(place: SavedPlace): Promise<void>
}

export type SavedAddress = {
  type: SavedPlaceType
  name: string
  address: string
  latitude: number
  longitude: number
}

export type ResolveSavedAddress = (query: string) => Promise<PlaceDetails | null>

/** Return only the fixed Home/Work slots, in a stable order for action callers. */
export async function getSavedAddresses(storage: SavedAddressStorage): Promise<{addresses: SavedAddress[]}> {
  const savedPlaces = await storage.getAllSavedPlaces()
  const addresses = SAVED_ADDRESS_TYPES.flatMap((type) => {
    const place = savedPlaces.find((candidate) => candidate.type === type)
    return place ? [toSavedAddress(place, type)] : []
  })
  return {addresses}
}

/** Resolve and replace one fixed saved-address slot. */
export async function setSavedAddress(
  params: Record<string, unknown>,
  storage: SavedAddressStorage,
  resolveAddress: ResolveSavedAddress,
): Promise<{address: SavedAddress}> {
  const type = params.type
  if (type !== "home" && type !== "work") {
    throw new Error("set_saved_address: 'type' must be 'home' or 'work'")
  }

  if (typeof params.address !== "string" || !params.address.trim()) {
    throw new Error("set_saved_address: 'address' is required and must be a non-empty string")
  }

  const query = params.address.trim()
  const place = await resolveAddress(query)
  if (!place) {
    throw new Error(`set_saved_address: couldn't find a place matching "${query}"`)
  }

  const savedPlace: SavedPlace = {
    ...place,
    type,
    savedName: type === "home" ? "Home" : "Work",
  }
  await storage.addSavedPlace(savedPlace)
  return {address: toSavedAddress(savedPlace, type)}
}

function toSavedAddress(place: SavedPlace, type: SavedPlaceType): SavedAddress {
  return {
    type,
    name: place.name,
    address: place.address,
    latitude: place.lat,
    longitude: place.lng,
  }
}
