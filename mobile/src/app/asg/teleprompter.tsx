import {useEffect, useState} from "react"
import {ScrollView, View, TextInput, TouchableOpacity, Alert} from "react-native"
import AsyncStorage from "@react-native-async-storage/async-storage"
import {Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import CoreModule from "@mentra/bluetooth-sdk"

const STORAGE_KEY = "teleprompter_scripts"

interface TeleprompterScript {
  id: string
  title: string
  body: string
  updatedAt: number
}

function makeId() {
  return `script_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
}

export default function TeleprompterScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()

  const [scripts, setScripts] = useState<TeleprompterScript[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [sending, setSending] = useState(false)

  useEffect(() => {
    loadScripts()
  }, [])

  async function loadScripts() {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY)
      const parsed: TeleprompterScript[] = raw ? JSON.parse(raw) : []
      setScripts(parsed.sort((a, b) => b.updatedAt - a.updatedAt))
    } catch (e) {
      console.error("Failed to load teleprompter scripts", e)
    }
  }

  async function saveScripts(next: TeleprompterScript[]) {
    setScripts(next.sort((a, b) => b.updatedAt - a.updatedAt))
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }

  function startNew() {
    setActiveId(null)
    setTitle("")
    setBody("")
  }

  function openScript(script: TeleprompterScript) {
    setActiveId(script.id)
    setTitle(script.title)
    setBody(script.body)
  }

  async function saveCurrent() {
    const trimmedTitle = title.trim() || "Untitled script"
    const id = activeId ?? makeId()
    const existingIndex = scripts.findIndex(s => s.id === id)
    const updated: TeleprompterScript = {
      id,
      title: trimmedTitle,
      body,
      updatedAt: Date.now(),
    }
    const next = [...scripts]
    if (existingIndex >= 0) {
      next[existingIndex] = updated
    } else {
      next.push(updated)
    }
    await saveScripts(next)
    setActiveId(id)
  }

  async function deleteScript(id: string) {
    const next = scripts.filter(s => s.id !== id)
    await saveScripts(next)
    if (activeId === id) {
      startNew()
    }
  }

  async function sendToGlasses() {
    if (!body.trim()) {
      Alert.alert("Empty script", "Write or load a script before sending.")
      return
    }
    await saveCurrent()
    const id = activeId ?? makeId()
    const lines = body.split("\n")
    setSending(true)
    try {
      await CoreModule.sendTeleprompterScript(id, lines)
      Alert.alert("Sent", "Script transferred to glasses.")
    } catch (e) {
      console.error("Failed to send teleprompter script", e)
      Alert.alert("Error", "Could not send script to glasses.")
    } finally {
      setSending(false)
    }
  }

  return (
    <Screen preset="fixed">
      <Header title="Teleprompter" leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        <View className="gap-4 pt-4">
          <View className="flex-row items-center justify-between">
            <Text style={{fontSize: 16, fontWeight: "600", color: theme.colors.text}} text="Saved scripts" />
            <TouchableOpacity onPress={startNew}>
              <Text style={{color: theme.colors.tint}} text="+ New" />
            </TouchableOpacity>
          </View>

          {scripts.length === 0 && (
            <Text style={{color: theme.colors.textDim, fontSize: 13}} text="No saved scripts yet." />
          )}

          {scripts.map(script => (
            <View
              key={script.id}
              className="flex-row items-center justify-between rounded-lg p-3"
              style={{backgroundColor: theme.colors.palette.neutral200}}>
              <TouchableOpacity style={{flex: 1}} onPress={() => openScript(script)}>
                <Text
                  style={{
                    fontWeight: activeId === script.id ? "700" : "400",
                    color: theme.colors.text,
                  }}
                  text={script.title}
                />
                <Text
                  style={{fontSize: 11, color: theme.colors.textDim}}
                  text={new Date(script.updatedAt).toLocaleString()}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteScript(script.id)} style={{paddingLeft: 12}}>
                <Text style={{color: theme.colors.error}} text="Delete" />
              </TouchableOpacity>
            </View>
          ))}

          <View className="gap-2 pt-2">
            <Text style={{fontSize: 16, fontWeight: "600", color: theme.colors.text}} text="Editor" />
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Script title"
              placeholderTextColor={theme.colors.textDim}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 8,
                padding: 10,
                color: theme.colors.text,
              }}
            />
            <TextInput
              value={body}
              onChangeText={setBody}
              placeholder="Type or paste your script here. Each line will be a teleprompter line."
              placeholderTextColor={theme.colors.textDim}
              multiline
              textAlignVertical="top"
              style={{
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 8,
                padding: 10,
                minHeight: 180,
                color: theme.colors.text,
              }}
            />
          </View>

          <View className="flex-row gap-3 pb-6">
            <TouchableOpacity
              onPress={saveCurrent}
              style={{
                flex: 1,
                borderRadius: 8,
                padding: 12,
                alignItems: "center",
                backgroundColor: theme.colors.palette.neutral200,
              }}>
              <Text style={{color: theme.colors.text, fontWeight: "600"}} text="Save" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={sendToGlasses}
              disabled={sending}
              style={{
                flex: 1,
                borderRadius: 8,
                padding: 12,
                alignItems: "center",
                backgroundColor: theme.colors.tint,
                opacity: sending ? 0.6 : 1,
              }}>
              <Text style={{color: theme.colors.palette.neutral100, fontWeight: "600"}} text={sending ? "Sending..." : "Send to Glasses"} />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </Screen>
  )
}
