import {useEffect, useState} from "react"
import {Modal, ScrollView, View} from "react-native"
import type {IncidentReportResult} from "@mentra/engine"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {useAuth} from "@/contexts/AuthContext"
import {useDeployment} from "@/services/deployment"
import {parseIncidentReportRequest, submitIncidentReportOnce} from "@/services/bugReport/incidentReportAutomation"

/** Available in every build through com.mentra://test/submit-incident-report.
 * The uploader uses the current authenticated engine; this screen never resets it.
 */
export default function IncidentReportRequest({
  params,
  onDismiss,
}: {
  params: Record<string, unknown>
  onDismiss: () => void
}) {
  const {user, session} = useAuth()
  const {activeDeployment} = useDeployment()
  const [result, setResult] = useState<IncidentReportResult | null>(null)
  const input = JSON.stringify(params)
  const authenticated = Boolean(user?.id && session?.token)
  const scope = JSON.stringify([
    user?.id,
    activeDeployment.manifest.deploymentId,
    activeDeployment.manifest.services.coreUrl,
  ])
  const state = {
    alert_id: typeof params.alert_id === "string" ? params.alert_id : undefined,
    test_run_id: typeof params.test_run_id === "string" ? params.test_run_id : undefined,
    status: !authenticated ? "authentication_required" : result ? "finished" : "submitting",
  }

  useEffect(() => {
    setResult(null)
    // Re-check when authentication changes while this modal is open.
    if (!authenticated) return
    const parsed = parseIncidentReportRequest(JSON.parse(input))
    if (!parsed.ok) {
      setResult({status: "failed", failure_code: "invalid_request", error: parsed.error})
      return
    }
    let mounted = true
    void submitIncidentReportOnce(scope, parsed.request).then((receipt) => {
      if (mounted) setResult(receipt)
    })
    return () => {
      mounted = false
    }
  }, [authenticated, input, scope])

  return (
    <Modal visible animationType="none" onRequestClose={onDismiss}>
      <Screen preset="fixed" safeAreaEdges={["bottom"]}>
        <Header titleTx="incidentAutomation:title" leftIcon="chevron-left" onLeftPress={onDismiss} />
        <ScrollView>
          <View className="gap-4 px-4 py-3">
            <Text
              tx={
                !authenticated
                  ? "incidentAutomation:signInRequired"
                  : result
                  ? "incidentAutomation:finished"
                  : "incidentAutomation:submitting"
              }
            />
            <Text selectable testID="incident-report-state" text={JSON.stringify(state)} />
            {result && <Text selectable testID="incident-report-result" text={JSON.stringify(result)} />}
            <Button testID="incident-report-done" tx="common:done" onPress={onDismiss} />
          </View>
        </ScrollView>
      </Screen>
    </Modal>
  )
}
