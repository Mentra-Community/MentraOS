import BottomSheet, {BottomSheetBackdrop, BottomSheetScrollView} from "@gorhom/bottom-sheet"
import {useCallback, useEffect, useMemo, useState} from "react"
import {ActivityIndicator, View} from "react-native"
import MaterialCommunityIcons from "react-native-vector-icons/MaterialCommunityIcons"

import {Text} from "@/components/ignite"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {PhotoInfo} from "@/types/asg"

import {loadMediaMetadata, LoadedMediaMetadata} from "./loadMediaMetadata"
import {buildMediaDetails, flattenExifMetadata, MediaDimensions, MetadataRow} from "./mediaMetadata"

interface MediaMetadataSheetProps {
  bottomSheetRef: React.RefObject<BottomSheet | null>
  photo: PhotoInfo
  dimensions?: MediaDimensions
  onChange: (index: number) => void
}

function MetadataRows({rows}: {rows: MetadataRow[]}) {
  const {theme} = useAppTheme()

  return (
    <View>
      {rows.map((row, index) => (
        <View
          key={`${row.label}-${index}`}
          style={{
            flexDirection: "row",
            gap: 16,
            paddingVertical: 12,
            borderBottomWidth: index === rows.length - 1 ? 0 : 1,
            borderBottomColor: theme.colors.border,
          }}>
          <Text style={{width: 118, color: theme.colors.muted_foreground, fontSize: 14}}>{row.label}</Text>
          <Text selectable style={{flex: 1, color: theme.colors.foreground, fontSize: 14, lineHeight: 20}}>
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  )
}

export function MediaMetadataSheet({bottomSheetRef, photo, dimensions, onChange}: MediaMetadataSheetProps) {
  const {theme} = useAppTheme()
  const insets = useSaferAreaInsets()
  const snapPoints = useMemo(() => ["62%", "92%"], [])
  const [loaded, setLoaded] = useState<LoadedMediaMetadata | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [hasOpened, setHasOpened] = useState(false)

  useEffect(() => {
    setLoaded(null)
    setHasOpened(false)
    setIsLoading(false)
  }, [photo.name])

  useEffect(() => {
    if (!hasOpened || loaded) return

    let cancelled = false
    setIsLoading(true)
    void loadMediaMetadata(photo)
      .then((metadata) => {
        if (!cancelled) setLoaded(metadata)
      })
      .catch((error) => {
        console.warn(`[GalleryMetadata] Could not load metadata for ${photo.name}:`, error)
        if (!cancelled) setLoaded({exif: null})
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hasOpened, loaded, photo])

  const handleChange = useCallback(
    (index: number) => {
      if (index >= 0) setHasOpened(true)
      onChange(index)
    },
    [onChange],
  )

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.45} pressBehavior="close" />
    ),
    [],
  )

  const details = buildMediaDetails(photo, dimensions, loaded?.actualSize)
  const exifRows = flattenExifMetadata(loaded?.exif)

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      animateOnMount={false}
      enableDynamicSizing={false}
      enablePanDownToClose
      enableContentPanningGesture
      enableHandlePanningGesture
      backdropComponent={renderBackdrop}
      onChange={handleChange}
      style={{zIndex: 200}}
      backgroundStyle={{backgroundColor: theme.colors.background}}
      handleIndicatorStyle={{backgroundColor: theme.colors.muted_foreground, width: 48}}>
      <BottomSheetScrollView contentContainerStyle={{paddingHorizontal: 24, paddingBottom: insets.bottom + 32}}>
        <View style={{flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 18}}>
          <View
            style={{
              width: 42,
              height: 42,
              borderRadius: 21,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: theme.colors.primary_foreground,
            }}>
            <MaterialCommunityIcons
              name={photo.is_video ? "video-outline" : "image-outline"}
              size={22}
              color={theme.colors.foreground}
            />
          </View>
          <View style={{flex: 1}}>
            <Text style={{color: theme.colors.foreground, fontSize: 20, fontWeight: "700"}}>Media details</Text>
            <Text numberOfLines={1} style={{color: theme.colors.muted_foreground, fontSize: 13, marginTop: 2}}>
              {photo.name}
            </Text>
          </View>
        </View>

        <MetadataRows rows={details} />

        <Text style={{color: theme.colors.foreground, fontSize: 17, fontWeight: "700", marginTop: 28, marginBottom: 4}}>
          EXIF metadata
        </Text>
        {isLoading ? (
          <View style={{flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 18}}>
            <ActivityIndicator color={theme.colors.foreground} />
            <Text style={{color: theme.colors.muted_foreground}}>Reading original file…</Text>
          </View>
        ) : exifRows.length > 0 ? (
          <MetadataRows rows={exifRows} />
        ) : (
          <Text style={{color: theme.colors.muted_foreground, fontSize: 14, paddingVertical: 14}}>
            {photo.is_video ? "EXIF data is not available for videos." : "No EXIF metadata found in this file."}
          </Text>
        )}
      </BottomSheetScrollView>
    </BottomSheet>
  )
}
