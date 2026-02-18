import {useState} from 'react'
import {View, ScrollView, TextInput, ActivityIndicator} from 'react-native'

import {Screen, Header, Text, Button} from '@/components/ignite'
import {useNavigationHistory} from '@/contexts/NavigationHistoryContext'
import {mpCliBridge} from '@/services/MpCliBridge'
import miniComms from '@/services/MiniComms'
import DisplayFormatter from '@/services/DisplayFormatter'

export default function MpCliBridgeTest() {
  const {goBack} = useNavigationHistory()
  
  const [bridgeUrl, setBridgeUrl] = useState('http://192.168.0.91:8421/api/v1')
  const [token, setToken] = useState('3l2LMHhjg5BH-XJfon0VmqIkhA1ZA9Dv1FWVnsxcbXU')
  const [command, setCommand] = useState('next')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string>('')
  const [connectionStatus, setConnectionStatus] = useState<string>('Not checked')

  const handleCheckConnection = async () => {
    setLoading(true)
    setResult('')
    
    try {
      mpCliBridge.configure(bridgeUrl, token)
      const status = await mpCliBridge.checkConnection()
      
      if (status.bridgeReachable) {
        setConnectionStatus('✅ Connected')
        setResult('Bridge is reachable!')
      } else {
        setConnectionStatus('❌ Unreachable')
        setResult('Bridge is not reachable. Check URL and network.')
      }
    } catch (error) {
      setConnectionStatus('❌ Error')
      setResult(`Error: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const handleExecuteCommand = async () => {
    setLoading(true)
    setResult('')
    
    try {
      mpCliBridge.configure(bridgeUrl, token)
      const response = await mpCliBridge.executeCommand(command)
      
      if (response.success) {
        const resultText = JSON.stringify(response.data, null, 2)
        setResult(resultText)
      } else {
        setResult(`Error: ${response.error}`)
      }
    } catch (error) {
      setResult(`Error: ${error}`)
    } finally {
      setLoading(false)
    }
  }

  const handleSendToG1 = () => {
    if (!result) {
      alert('No result to send. Execute a command first.')
      return
    }

    try {
      // Parse the result and format for G1
      let textToSend = result
      
      try {
        const parsed = JSON.parse(result)
        
        // If it's mp next output, format it specially
        if (command === 'next' && parsed.output) {
          textToSend = DisplayFormatter.formatNext(parsed)
        } else if (parsed.output) {
          // Generic formatting for other commands
          textToSend = DisplayFormatter.formatGeneric(parsed.output)
        }
      } catch {
        // If not JSON, format as generic text
        textToSend = DisplayFormatter.formatGeneric(result)
      }

      console.log('[G1 Display]', textToSend)
      miniComms.sendToGlasses(textToSend)
      alert('Sent to G1!')
    } catch (error) {
      alert(`Error sending to G1: ${error}`)
    }
  }

  return (
    <Screen preset="fixed" safeAreaEdges={[]}>
      <Header
        title="MP-CLI Bridge Test"
        titleMode="center"
        leftIcon="chevron-left"
        onLeftPress={() => goBack()}
        style={{height: 44}}
      />
      
      <ScrollView className="flex-1 p-4">
        <View className="mb-4">
          <Text className="text-foreground font-semibold mb-2">Bridge URL</Text>
          <TextInput
            value={bridgeUrl}
            onChangeText={setBridgeUrl}
            placeholder="http://192.168.0.91:8421/api/v1"
            className="bg-background border border-border rounded-lg p-3 text-foreground"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        <View className="mb-4">
          <Text className="text-foreground font-semibold mb-2">Token</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            placeholder="Your bridge token"
            className="bg-background border border-border rounded-lg p-3 text-foreground"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
        </View>

        <View className="mb-4">
          <Text className="text-foreground font-semibold mb-2">
            Status: {connectionStatus}
          </Text>
          <Button
            text="Check Connection"
            onPress={handleCheckConnection}
            disabled={loading}
            className="mb-2"
          />
        </View>

        <View className="mb-4">
          <Text className="text-foreground font-semibold mb-2">Command</Text>
          <TextInput
            value={command}
            onChangeText={setCommand}
            placeholder="next"
            className="bg-background border border-border rounded-lg p-3 text-foreground mb-2"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button
            text="Execute Command"
            onPress={handleExecuteCommand}
            disabled={loading}
          />
        </View>

        {loading && (
          <View className="items-center py-4">
            <ActivityIndicator size="large" />
            <Text className="text-foreground mt-2">Loading...</Text>
          </View>
        )}

        {result && (
          <View className="mb-4">
            <Text className="text-foreground font-semibold mb-2">Result:</Text>
            <ScrollView 
              className="bg-background border border-border rounded-lg p-3 max-h-96"
              nestedScrollEnabled
            >
              <Text className="text-foreground text-xs font-mono">
                {result}
              </Text>
            </ScrollView>
            <Button
              text="Send to G1"
              onPress={handleSendToG1}
              className="mt-2"
            />
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}
