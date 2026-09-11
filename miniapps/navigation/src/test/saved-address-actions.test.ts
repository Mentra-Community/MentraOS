import {describe, expect, mock, test} from "bun:test"

import {getSavedAddresses, setSavedAddress} from "../background/actions/savedAddressActions"
import type {PlaceDetails, SavedPlace} from "../background/lib/places"

const home: SavedPlace = {
  placeId: "home-id",
  name: "Home Place",
  address: "1 Home St",
  lat: 37.1,
  lng: -122.1,
  savedName: "Home",
  type: "home",
}

const work: SavedPlace = {
  placeId: "work-id",
  name: "Work Place",
  address: "2 Work Ave",
  lat: 37.2,
  lng: -122.2,
  savedName: "Work",
  type: "work",
}

describe("saved-address actions", () => {
  test("gets only Home and Work in stable slot order", async () => {
    const favorite: SavedPlace = {
      placeId: "favorite-id",
      name: "Coffee",
      address: "3 Coffee Ln",
      lat: 37.3,
      lng: -122.3,
    }
    const storage = {
      getAllSavedPlaces: mock(async () => [work, favorite, home]),
      addSavedPlace: mock(async () => {}),
    }

    await expect(getSavedAddresses(storage)).resolves.toEqual({
      addresses: [
        {type: "home", name: "Home Place", address: "1 Home St", latitude: 37.1, longitude: -122.1},
        {type: "work", name: "Work Place", address: "2 Work Ave", latitude: 37.2, longitude: -122.2},
      ],
    })
  })

  test("resolves and saves one address slot", async () => {
    const resolved: PlaceDetails = {
      placeId: "resolved-id",
      name: "Mentra HQ",
      address: "369 Hayes St, San Francisco, CA",
      lat: 37.7764,
      lng: -122.4222,
    }
    const storage = {
      getAllSavedPlaces: mock(async () => []),
      addSavedPlace: mock(async () => {}),
    }
    const resolveAddress = mock(async () => resolved)

    await expect(
      setSavedAddress({type: "work", address: "  369 Hayes St  "}, storage, resolveAddress),
    ).resolves.toEqual({
      address: {
        type: "work",
        name: "Mentra HQ",
        address: "369 Hayes St, San Francisco, CA",
        latitude: 37.7764,
        longitude: -122.4222,
      },
    })
    expect(resolveAddress).toHaveBeenCalledWith("369 Hayes St")
    expect(storage.addSavedPlace).toHaveBeenCalledWith({...resolved, type: "work", savedName: "Work"})
  })

  test.each([
    [{address: "1 Home St"}, "'type' must be 'home' or 'work'"],
    [{type: "other", address: "1 Home St"}, "'type' must be 'home' or 'work'"],
    [{type: "home"}, "'address' is required"],
    [{type: "home", address: "   "}, "'address' is required"],
  ])("rejects invalid parameters", async (params, message) => {
    const storage = {
      getAllSavedPlaces: mock(async () => []),
      addSavedPlace: mock(async () => {}),
    }

    await expect(
      setSavedAddress(
        params,
        storage,
        mock(async () => null),
      ),
    ).rejects.toThrow(message)
    expect(storage.addSavedPlace).not.toHaveBeenCalled()
  })

  test("does not overwrite a slot when place search finds no match", async () => {
    const storage = {
      getAllSavedPlaces: mock(async () => []),
      addSavedPlace: mock(async () => {}),
    }

    await expect(
      setSavedAddress(
        {type: "home", address: "not a real place"},
        storage,
        mock(async () => null),
      ),
    ).rejects.toThrow("couldn't find a place matching")
    expect(storage.addSavedPlace).not.toHaveBeenCalled()
  })
})
