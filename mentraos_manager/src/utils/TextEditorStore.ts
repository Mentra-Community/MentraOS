// Simple store for passing text editor values back
class TextEditorStore {
  private pendingValue: {key: string; value: string} | null = null

  setPendingValue(key: string, value: string) {
    this.pendingValue = {key, value}
  }

  getPendingValue(): {key: string; value: string} | null {
    const value = this.pendingValue
    this.pendingValue = null // Clear after reading
    return value
  }
}

export const textEditorStore = new TextEditorStore()
