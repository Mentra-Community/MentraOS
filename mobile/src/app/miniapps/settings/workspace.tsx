import {useFocusEffect} from "@react-navigation/native"
import {useCallback, useEffect, useState} from "react"
import {ScrollView, View} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {leaveWithConfirm, ManagementLine, roleLabel, SeeLists, WorkspaceTile} from "@/effects/FleetSheets"
import {translate} from "@/i18n/translate"
import {refreshMyWorkspace, useMyWorkspaceStore} from "@/services/fleet/myWorkspace"
import {useNavigationStore} from "@/stores/navigation"

/**
 * The workspace the person is in: its name and their role, who manages them, what the workspace can and can't
 * see, and Leave. Hidden when they are in no workspace. The role is read again each time the page gains focus.
 */
export default function WorkspaceScreen() {
  const {goBack} = useNavigationStore.getState()
  const {theme} = useAppTheme()
  const workspace = useMyWorkspaceStore((state) => state.workspace)
  const loaded = useMyWorkspaceStore((state) => state.loaded)
  const [lastOwner, setLastOwner] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useFocusEffect(
    useCallback(() => {
      void refreshMyWorkspace()
    }, []),
  )

  // No workspace (never joined, left, or removed): there is nothing to show here.
  useEffect(() => {
    if (loaded && !workspace) goBack()
  }, [loaded, workspace, goBack])

  if (!workspace) return null

  const leave = async () => {
    if (leaving) return
    setLeaving(true)
    try {
      if ((await leaveWithConfirm(workspace)) === "last_owner") setLastOwner(true)
    } finally {
      setLeaving(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("fleet:pageTitle")} leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView className="px-6 pt-4" contentContainerClassName="gap-6 pb-16">
        <View className="flex-row items-center gap-4" testID="workspace.header">
          <WorkspaceTile name={workspace.name} />
          <View className="flex-1">
            <Text text={workspace.name} weight="semibold" className="text-xl text-secondary-foreground" />
            <Text text={roleLabel(workspace.role)} className="text-sm text-muted-foreground" testID="workspace.role" />
          </View>
        </View>
        <ManagementLine />
        <SeeLists />
        {lastOwner ? (
          <Text
            text={translate("fleet:lastOwner")}
            className="text-center text-[15px] leading-[21px] text-muted-foreground"
            testID="workspace.lastOwner"
          />
        ) : (
          <Button
            text={translate("fleet:leaveWorkspace")}
            preset="alternate"
            className="min-h-[50px]"
            textStyle={{fontSize: 16, color: theme.colors.error}}
            disabled={leaving}
            onPress={leave}
            testID="workspace.leave"
          />
        )}
      </ScrollView>
    </Screen>
  )
}
