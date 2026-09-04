const path = require('node:path');
const fs = require('node:fs');
const ts = require('typescript');

const config = ts.getParsedCommandLineOfConfigFile(path.join(__dirname, 'tsconfig.json'), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: diagnostic => {
    console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    process.exit(1);
  },
});

const sdkRoot = process.env.MENTRA_BLUETOOTH_SDK_PACKAGE_PATH;
if (sdkRoot) {
  for (const entry of ['src/index.ts', 'src/react/index.ts']) {
    if (!fs.existsSync(path.resolve(sdkRoot, entry))) {
      throw new Error(`Missing SDK source entry: ${path.resolve(sdkRoot, entry)}`);
    }
  }
  // Match Metro's source override and resolve that checkout's dependencies from this app.
  config.options.paths = {
    '@mentra/bluetooth-sdk': [path.resolve(sdkRoot, 'src/index.ts')],
    '@mentra/bluetooth-sdk/react': [path.resolve(sdkRoot, 'src/react/index.ts')],
    'react': [path.join(__dirname, 'node_modules/@types/react')],
    'react/*': [path.join(__dirname, 'node_modules/@types/react/*')],
    'react-native': [path.join(__dirname, 'node_modules/react-native-macos')],
    'react-native/*': [path.join(__dirname, 'node_modules/react-native-macos/*')],
    '*': [path.join(__dirname, 'node_modules/*')],
  };
}

const program = ts.createProgram(config.fileNames, config.options);
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  }));
  process.exit(1);
}
