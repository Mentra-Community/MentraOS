import {readFile} from "fs/promises"
import {createRequire} from "module"
import {dirname, isAbsolute, join, relative, resolve} from "path"
import {fileURLToPath} from "url"
import ts from "typescript"

type ResolveArgs = {path: string}
type ResolveResult = {path: string}
type LoadArgs = {path: string}
type LoadResult = {contents: string; loader: "js" | "jsx" | "ts" | "tsx"}
type BunBuild = {
  onResolve(args: {filter: RegExp}, callback: (args: ResolveArgs) => ResolveResult): void
  onLoad(args: {filter: RegExp}, callback: (args: LoadArgs) => Promise<LoadResult | undefined>): void
}

export interface BackgroundRuntimeFinding {
  api: string
  line: number
  column: number
  replacement: string
}

const UNSUPPORTED_BACKGROUND_GLOBALS = new Map<string, string>([
  ["window", "move browser/UI work to src/ui/"],
  ["document", "move DOM work to src/ui/"],
  ["navigator", "move browser capability checks to src/ui/"],
  ["location", "use session.location for glasses/phone location, or move browser URL work to src/ui/"],
  ["performance", "use Date.now() for elapsed time"],
  ["XMLHttpRequest", "use fetch()"],
  ["EventSource", "use fetch() or WebSocket"],
  ["FormData", "send a supported string request body"],
  ["File", "move browser file handling to src/ui/ or use session.blob"],
  ["FileReader", "move browser file handling to src/ui/ or use session.blob"],
  ["Blob", "use session.blob for binary storage"],
  ["URL", "pass URL strings directly"],
  ["URLSearchParams", "build the query string explicitly"],
  ["Request", "call fetch() with a URL string and options"],
  ["Response", "consume the object returned by fetch()"],
  ["Headers", "pass a plain header record to fetch()"],
  ["Worker", "keep durable work in the background entry itself"],
  ["MessageChannel", "use session.ui channels"],
  ["MutationObserver", "move DOM work to src/ui/"],
  ["HTMLElement", "move DOM work to src/ui/"],
  ["customElements", "move DOM work to src/ui/"],
  ["indexedDB", "use session.storage, session.blob, or localStorage"],
  ["caches", "use session.storage, session.blob, or localStorage"],
  ["process", "remove the Node API; build.ts only inlines MENTRA_PUBLIC_* values"],
  ["Buffer", "use Uint8Array plus TextEncoder/TextDecoder or the SDK base64 helpers"],
  ["require", "use a static import that Bun can bundle"],
  ["module", "use ES modules"],
  ["exports", "use ES module exports"],
  ["__dirname", "do not read the filesystem at runtime"],
  ["__filename", "do not read the filesystem at runtime"],
])

const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
])

function nodeBuiltinName(specifier: string): string | null {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier
  const root = bare.split("/")[0]!
  return NODE_BUILTINS.has(root) ? specifier : null
}

function importHasRuntimeBindings(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return true
  return clause.namedBindings?.elements.some((element) => !element.isTypeOnly) ?? false
}

function exportHasRuntimeBindings(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true
  return node.exportClause.elements.some((element) => !element.isTypeOnly)
}

function isDeclarationOrPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent
  if (!parent) return false
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true
  if (ts.isPropertySignature(parent) && parent.name === node) return true
  if (ts.isBindingElement(parent) && parent.name === node) return true
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true
  if (ts.isParameter(parent) && parent.name === node) return true
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true
  if (ts.isFunctionExpression(parent) && parent.name === node) return true
  if (ts.isClassDeclaration(parent) && parent.name === node) return true
  if (ts.isClassExpression(parent) && parent.name === node) return true
  if (ts.isInterfaceDeclaration(parent) && parent.name === node) return true
  if (ts.isTypeAliasDeclaration(parent) && parent.name === node) return true
  if (ts.isEnumDeclaration(parent) && parent.name === node) return true
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) return true
  if (ts.isExportSpecifier(parent)) return true
  if (ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return true
  return false
}

function isPublicEnvAccess(node: ts.Identifier): boolean {
  const envAccess = node.parent
  if (
    node.text !== "process" ||
    !envAccess ||
    !ts.isPropertyAccessExpression(envAccess) ||
    envAccess.expression !== node ||
    envAccess.name.text !== "env"
  ) {
    return false
  }

  const valueAccess = envAccess.parent
  return (
    ts.isPropertyAccessExpression(valueAccess) &&
    valueAccess.expression === envAccess &&
    valueAccess.name.text.startsWith("MENTRA_PUBLIC_")
  )
}

/** Analyze one background source file against the documented bare-runtime contract. */
export function findUnsupportedBackgroundApis(
  sourceText: string,
  fileName = "background.ts",
): BackgroundRuntimeFinding[] {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, kind)
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.Latest,
  }
  const host = ts.createCompilerHost(compilerOptions)
  host.fileExists = (candidate) => candidate === fileName
  host.getSourceFile = (candidate) => (candidate === fileName ? source : undefined)
  host.readFile = (candidate) => (candidate === fileName ? sourceText : undefined)
  host.writeFile = () => {}
  const checker = ts.createProgram([fileName], compilerOptions, host).getTypeChecker()
  const findings: BackgroundRuntimeFinding[] = []
  const seen = new Set<string>()

  const isLocallyBound = (node: ts.Identifier): boolean =>
    checker
      .getSymbolAtLocation(node)
      ?.declarations?.some((declaration) => declaration.getSourceFile() === source) ?? false

  const globalObjectPath = (node: ts.PropertyAccessExpression): string[] | null => {
    const properties: string[] = []
    let expression: ts.Expression = node
    while (ts.isPropertyAccessExpression(expression)) {
      properties.unshift(expression.name.text)
      expression = expression.expression
    }
    if (
      !ts.isIdentifier(expression) ||
      (expression.text !== "globalThis" && expression.text !== "self") ||
      isLocallyBound(expression)
    ) {
      return null
    }
    return [expression.text, ...properties]
  }

  const add = (node: ts.Node, api: string, replacement: string): void => {
    const start = node.getStart(source)
    const {line, character} = source.getLineAndCharacterOfPosition(start)
    const key = `${api}:${line}:${character}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({api, line: line + 1, column: character + 1, replacement})
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      importHasRuntimeBindings(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const builtin = nodeBuiltinName(node.moduleSpecifier.text)
      if (builtin) {
        add(node.moduleSpecifier, builtin, "remove the Node built-in; it is unavailable in background")
      }
    }

    if (
      ts.isExportDeclaration(node) &&
      exportHasRuntimeBindings(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const builtin = nodeBuiltinName(node.moduleSpecifier.text)
      if (builtin) {
        add(node.moduleSpecifier, builtin, "remove the Node built-in; it is unavailable in background")
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      const specifier = node.arguments[0]
      if (specifier && ts.isStringLiteral(specifier)) {
        const builtin = nodeBuiltinName(specifier.text)
        if (builtin) add(specifier, builtin, "remove the Node built-in; it is unavailable in background")
      }
    }

    if (
      ts.isPropertyAccessExpression(node)
    ) {
      const path = globalObjectPath(node)
      if (path?.[1] === "crypto" && path[2] === "subtle") {
        add(node, `${path[0]}.crypto.subtle`, "use crypto.getRandomValues/randomUUID or move cryptography behind your backend")
      } else if (path?.[1]) {
        const replacement = UNSUPPORTED_BACKGROUND_GLOBALS.get(path[1])
        if (replacement) add(node, `${path[0]}.${path[1]}`, replacement)
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "crypto" &&
      !isLocallyBound(node.expression) &&
      node.name.text === "subtle"
    ) {
      add(node, "crypto.subtle", "use crypto.getRandomValues/randomUUID or move cryptography behind your backend")
    }

    if (
      ts.isIdentifier(node) &&
      !isDeclarationOrPropertyName(node) &&
      !isLocallyBound(node) &&
      !isPublicEnvAccess(node)
    ) {
      const replacement = UNSUPPORTED_BACKGROUND_GLOBALS.get(node.text)
      if (replacement) add(node, node.text, replacement)
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return findings.sort((a, b) => a.line - b.line || a.column - b.column)
}

/**
 * Fail the background bundle when source code relies on browser or Node APIs
 * that do not exist in MentraOS's JavaScriptCore/QuickJS runtime.
 */
export function backgroundRuntimeGuardPlugin(importMetaUrl: string) {
  const sourceRoot = resolve(dirname(fileURLToPath(importMetaUrl)), "src")
  return {
    name: "mentra-background-runtime-guard",
    setup(build: BunBuild) {
      build.onLoad({filter: /\.[cm]?[jt]sx?$/}, async ({path}) => {
        const rel = relative(sourceRoot, path)
        if (rel.startsWith("..") || isAbsolute(rel)) return undefined

        const contents = await readFile(path, "utf8")
        const findings = findUnsupportedBackgroundApis(contents, path)
        if (findings.length > 0) {
          const details = findings
            .map(({api, line, column, replacement}) => `  ${rel}:${line}:${column} ${api}: ${replacement}`)
            .join("\n")
          throw new Error(
            `Unsupported API in Mentra miniapp background runtime:\n${details}\n` +
              "Background is not a browser or Node. Put browser UI code in src/ui/.",
          )
        }

        const ext = path.split(".").pop()
        const loader =
          ext === "tsx" ? "tsx" : ext === "jsx" ? "jsx" : ext === "ts" || ext === "mts" || ext === "cts" ? "ts" : "js"
        return {contents, loader}
      })
    },
  }
}

/**
 * Force React and ReactDOM imports in a miniapp UI bundle to resolve to one
 * package instance. This prevents invalid-hook-call crashes when a workspace
 * has multiple React versions available and Bun resolves `react/jsx-runtime`
 * from a dependency tree different from `react-dom/client`.
 */
export function reactSingletonPlugin(importMetaUrl: string) {
  const require = createRequire(importMetaUrl)
  const reactRoot = dirname(require.resolve("react/package.json"))
  const reactDomRoot = dirname(require.resolve("react-dom/package.json"))

  const aliases = new Map([
    ["react", join(reactRoot, "index.js")],
    ["react/jsx-runtime", join(reactRoot, "jsx-runtime.js")],
    ["react/jsx-dev-runtime", join(reactRoot, "jsx-dev-runtime.js")],
    ["react-dom", join(reactDomRoot, "index.js")],
    ["react-dom/client", join(reactDomRoot, "client.js")],
  ])

  return {
    name: "mentra-react-singleton",
    setup(build: BunBuild) {
      build.onResolve({filter: /^react(?:\/jsx-runtime|\/jsx-dev-runtime)?$/}, ({path}) => {
        return {path: aliases.get(path)!}
      })
      build.onResolve({filter: /^react-dom(?:\/client)?$/}, ({path}) => {
        return {path: aliases.get(path)!}
      })
    },
  }
}
