const {withKotlinVersion} = require("../withKotlinVersion")

interface GradleProperty {
  type: "property"
  key: string
  value: string
}

const EXPO_PROJECT_GRADLE = `buildscript {
  dependencies {
    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
  }
}
apply plugin: "expo-root-project"
`

async function applyKotlinConfig(
  properties: GradleProperty[] = [],
  contents = EXPO_PROJECT_GRADLE,
  language = "groovy",
) {
  const config = withKotlinVersion({name: "test", slug: "test"})
  const gradleProperties = await config.mods.android.gradleProperties({
    ...config,
    modRequest: {},
    modResults: properties,
  })
  const projectBuildGradle = await config.mods.android.projectBuildGradle({
    ...config,
    modRequest: {},
    modResults: {language, contents},
  })
  return {properties: gradleProperties.modResults, contents: projectBuildGradle.modResults.contents}
}

describe("Bluetooth SDK Android source compiler", () => {
  it("selects a compiler that can read AVIF metadata in an Expo host without Crust", async () => {
    const result = await applyKotlinConfig()
    expect(result.properties).toContainEqual({type: "property", key: "android.kotlinVersion", value: "2.3.0"})
    expect(result.contents).toContain(
      "classpath(\"org.jetbrains.kotlin:kotlin-gradle-plugin:${findProperty('android.kotlinVersion')}\")",
    )
    expect(result.contents).toContain(
      "ext.kotlinVersion = findProperty('android.kotlinVersion')\napply plugin: \"expo-root-project\"",
    )
  })

  it.each(["2.1.20", "2.2.21"])("upgrades the host's %s compiler", async (value) => {
    const result = await applyKotlinConfig([{type: "property", key: "android.kotlinVersion", value}])
    expect(result.properties).toEqual([{type: "property", key: "android.kotlinVersion", value: "2.3.0"}])
  })

  it.each(["2.3.0", "2.3.20", "2.4.0"])("preserves a compatible %s compiler", async (value) => {
    const result = await applyKotlinConfig([{type: "property", key: "android.kotlinVersion", value}])
    expect(result.properties).toEqual([{type: "property", key: "android.kotlinVersion", value}])
  })

  it("does not duplicate configuration when prebuild runs again", async () => {
    const first = await applyKotlinConfig()
    const second = await applyKotlinConfig(first.properties, first.contents)
    expect(second).toEqual(first)
  })

  it("preserves the compiler selection already applied by Crust", async () => {
    const contents = EXPO_PROJECT_GRADLE.replace(
      "classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')",
      "classpath(\"org.jetbrains.kotlin:kotlin-gradle-plugin:${findProperty('android.kotlinVersion')}\")",
    ).replace(
      'apply plugin: "expo-root-project"',
      "// kotlinVersion from android.kotlinVersion (injected by @mentra/crust)\next.kotlinVersion = findProperty('android.kotlinVersion')\napply plugin: \"expo-root-project\"",
    )
    const result = await applyKotlinConfig([{type: "property", key: "android.kotlinVersion", value: "2.3.0"}], contents)
    expect(result.contents).toBe(contents)
  })
})
