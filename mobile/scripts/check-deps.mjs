async function checkDeps() {
  console.log("Checking dependencies...")
  
  // check if nvm's script exists:
  const nvmDir = process.env.NVM_DIR || `${process.env.HOME}/.nvm`
  if (!fs.existsSync(`${nvmDir}/nvm.sh`)) {
    console.warn("⚠️  nvm not found...")
  }

  // Check if swiftformat is installed
  try {
    await $`command -v swiftformat`
  } catch {
    console.warn(`
      ⚠️  swiftformat not found.
      
      Install it with Homebrew:
      
        brew install swiftformat
      `)
  }
}

export default checkDeps

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkDeps()
}
