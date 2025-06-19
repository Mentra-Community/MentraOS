import AsyncStorage from "@react-native-async-storage/async-storage"

const saveSetting = async (key: string, value: any): Promise<void> => {
  try {
    const jsonValue = JSON.stringify(value)
    await AsyncStorage.setItem(key, jsonValue)
  } catch (error) {
    console.error(`Failed to save setting (${key}):`, error)
  }
}

const loadSetting = async (key: string, defaultValue: any) => {
  try {
    const jsonValue = await AsyncStorage.getItem(key)
    return jsonValue !== null ? JSON.parse(jsonValue) : defaultValue
  } catch (error) {
    console.error(`Failed to load setting (${key}):`, error)
    return defaultValue
  }
}

export {saveSetting, loadSetting}
