This is a representative extracted policy sample, not the complete diagnostic
class or a qualified APK. `preArmCaptureRequired` and `allowUnarmedWearable` copy
the native expressions; manager/admit are simplified wrappers used to expose
compiler instruction forms. Full capability validation remains mandatory on the
actual signed APK.

Generated using pinned Kotlin 2.3.0 and AGP 8.12.0's bundled D8 8.12.14,
`--min-api 28 --intermediate` with default desugaring, then official SDK
command-line-tools 19.0 `apkanalyzer dex code --class
com.mentra.bluetoothsdk.sgcs.NimoResourceDiagnostics policy.zip`.

Compiler command:

```
java -cp '/tmp/nimo-kotlin-23/*' org.jetbrains.kotlin.cli.jvm.K2JVMCompiler \
  -no-stdlib -no-reflect -classpath /tmp/nimo-kotlin-23/kotlin-stdlib.jar \
  -module-name bluetooth_sdk_nimoDiagnostic -d policy.jar Policy.kt
java -cp builder-8.12.0.jar com.android.tools.r8.D8 \
  --min-api 28 --intermediate --output policy.zip policy.jar
```

SHA256:

- Source: `938cf2e859eccb5841ef096f098b3add0d3b42776d53648a7a448231652e9142`
- DEX archive: `e8347f251acabe470e0c7d1ddec6d4e7705ebd2845f6746973cbe6fd1ccf0c05`
- Disassembly: `624083fc48441558fb7c60ffaf1a941c58d59f37b4b1010be3ef909edfd9d1fd`
- Compiler jar: `8dbd882fa58c3d17e683a27390288315f8b490f8e3e3b1be4dc3e280d37e285a`
- AGP builder jar: `2763db5ef7236c7109412b125610bc9120ac1a59e2ea4c04746f0299284ed663`

Actual diagnostic run 38994868110 compiled successfully but publication rejected
the aggregate deny-before-arm proof. Its APK was not retained by Actions or
uploaded (validation precedes upload). This sample establishes a concrete
matcher incompatibility; it does not establish that this was the only failed
obligation in that APK. Failure messages now identify each failed obligation.

`SnapshotPolicy.kt` additionally copies the complete current native
`captureSnapshot` expression unchanged. `Android.kt` and `Json.kt` are minimal
signature stubs (including the actual JSONObject boolean/long/int/object
 overloads); the surrounding Capture/Nimo wrappers are simplified. Its
`snapshot.smali` exposes the actual key-after-result allocation. Compile this
sample separately, excluding `Policy.kt`, with the same compiler/D8/analyzer
commands. It remains representative code, not the actual signed APK.

Snapshot witness SHA256:

- Snapshot source: `fe0da373e89a99ad6068d187e48588729fb61808eb0aab3d8776728fc334715e`
- Android stubs: `c3e62b81d15bf639819b41d05255171b42970bed7850d1bbbd48ac3da03a1ff6`
- JSON stubs: `72cb7048d733cd708679a0ad5ed455ba33395d315f57d6831dc9ac2791425906`
- DEX archive: `d528c9bf8743716b102d8e94c7318127fad7b08624736fade7a1d35e88de5db9`
- Disassembly: `cba6a13097f5a451b83988455506683c371aed3b7aaf50fe0f13270e3c74f0fd`
