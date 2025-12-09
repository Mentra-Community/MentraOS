import {useFocusEffect} from "@react-navigation/native"
import {useCallback} from "react"
import {ScrollView} from "react-native"

import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import {HomeContainer} from "@/components/home/HomeContainer"
import {Header, Screen} from "@/components/ignite"
import CloudConnection from "@/components/misc/CloudConnection"
import SensingDisabledWarning from "@/components/misc/SensingDisabledWarning"
import {Spacer} from "@/components/ui/Spacer"
import {useRefreshApplets} from "@/stores/applets"
import {useAppTheme} from "@/utils/useAppTheme"

export default function Homepage() {
  const {theme} = useAppTheme()
  const refreshApplets = useRefreshApplets()

  useFocusEffect(
    useCallback(() => {
      setTimeout(() => {
        refreshApplets()
      }, 1000)
    }, []),
  )

  return (
    <Screen preset="fixed" style={{paddingHorizontal: theme.spacing.s6}}>
      <Header leftTx="home:title" RightActionComponent={<MentraLogoStandalone />} />

      <ScrollView contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
        <Spacer height={theme.spacing.s4} />
        <CloudConnection />
        <SensingDisabledWarning />
        <HomeContainer />
      </ScrollView>
    </Screen>
  )
}
