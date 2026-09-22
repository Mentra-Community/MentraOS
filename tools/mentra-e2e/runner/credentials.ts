async function secretLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      "Provide MENTRA_E2E_EMAIL and MENTRA_E2E_PASSWORD through the environment, or run from an interactive terminal",
    )
  process.stdout.write(prompt)
  const previousRaw = process.stdin.isRaw
  process.stdin.setRawMode(true)
  process.stdin.resume()
  try {
    return await new Promise((resolve, reject) => {
      let text = ""
      const onData = (data: Buffer) => {
        for (const character of data.toString("utf8")) {
          if (character === "\u0003") {
            process.stdin.off("data", onData)
            reject(new Error("Credential entry cancelled"))
            return
          }
          if (character === "\r" || character === "\n") {
            process.stdin.off("data", onData)
            resolve(text)
            return
          }
          if (character === "\u007f" || character === "\b") text = text.slice(0, -1)
          else text += character
        }
      }
      process.stdin.on("data", onData)
    })
  } finally {
    process.stdin.setRawMode(previousRaw)
    process.stdin.pause()
    process.stdout.write("\n")
  }
}

export async function credentials() {
  const email = process.env.MENTRA_E2E_EMAIL || (await secretLine("Test account email (input hidden): "))
  const password = process.env.MENTRA_E2E_PASSWORD || (await secretLine("Test account password (input hidden): "))
  if (!email || !password) throw new Error("Both test account credentials are required")
  return {email, password}
}
