import {Directory} from "expo-file-system"

// export async function downloadFile(url: string, destination: Directory): Promise<File> {}

export function printDirectory(directory: Directory, indent: number = 0) {
  console.log(`${" ".repeat(indent)} + ${directory.name}`)
  const contents = directory.list()
  for (const item of contents) {
    if (item instanceof Directory) {
      printDirectory(item, indent + 2)
    } else {
      console.log(`${" ".repeat(indent + 2)} - ${item.name} (${item.size} bytes)`)
    }
  }
}