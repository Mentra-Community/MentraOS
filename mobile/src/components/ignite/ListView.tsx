import {FlashList, FlashListProps, FlashListRef} from "@shopify/flash-list"
import {ForwardedRef, forwardRef, PropsWithoutRef, ReactElement, RefObject} from "react"
import {FlatList, FlatListProps} from "react-native"

import {isRTL} from "@/i18n"

export type ListViewRef<T> = FlashListRef<T> | FlatList<T>

export type ListViewProps<T> = PropsWithoutRef<FlashListProps<T>>

/**
 * This is a Higher Order Component meant to ease the pain of using @shopify/flash-list
 * when there is a chance that a user would have their device language set to an
 * RTL language like Arabic or Persian. This component will use react-native's
 * FlatList if the user's language is RTL or FlashList if the user's language is LTR.
 *
 * Because FlashList's props are a superset of FlatList's, you must pass estimatedItemSize
 * to this component if you want to use it.
 *
 * This is a temporary workaround until the FlashList component supports RTL at
 * which point this component can be removed and we will default to using FlashList everywhere.
 * @see {@link https://github.com/Shopify/flash-list/issues/544|RTL Bug Android}
 * @see {@link https://github.com/Shopify/flash-list/issues/840|Flashlist Not Support RTL}
 * @param {FlashListProps | FlatListProps} props - The props for the `ListView` component.
 * @param {RefObject<ListViewRef>} forwardRef - An optional forwarded ref.
 * @returns {JSX.Element} The rendered `ListView` component.
 */
const ListViewComponent = forwardRef(<T,>(props: ListViewProps<T>, ref: ForwardedRef<ListViewRef<T>>) => {
  if (isRTL) {
    return <FlatList {...(props as FlatListProps<T>)} ref={ref as ForwardedRef<FlatList<T>>} />
  }

  return <FlashList {...props} ref={ref as ForwardedRef<FlashListRef<T>>} />
})

ListViewComponent.displayName = "ListView"

export const ListView = ListViewComponent as <T>(
  props: ListViewProps<T> & {
    ref?: RefObject<ListViewRef<T>>
  },
) => ReactElement
