// Which Mentra App a build is: the dev app (com.mentra.mentra.dev, on the dev
// backend) or the Mentra App (com.mentra.mentra, on staging and production).
// See design_docs/platform/releases/dev-app-track/spec.md in the monorepo.
//
// MENTRA_APP_TRACK names it (`dev` or `staging`). CI always sets it from the
// branch or the PR's base. A local build without it takes the track of the
// branch its checkout is closest to: whichever of origin/dev and
// origin/staging has the nearer merge base with HEAD, staging on a tie, since
// that code is on its way to a release.
const {execFileSync} = require("node:child_process")
const path = require("node:path")

const TRACKS = new Set(["dev", "staging"])
const repositoryRoot = path.resolve(__dirname, "..")

function commitsSinceMergeBase(branch, run) {
  const base = run(["merge-base", "HEAD", branch])
  return Number(run(["rev-list", "--count", `${base}..HEAD`]))
}

function nearestTrack(run) {
  const dev = commitsSinceMergeBase("origin/dev", run)
  const staging = commitsSinceMergeBase("origin/staging", run)
  return dev < staging ? "dev" : "staging"
}

const git = (args) =>
  execFileSync("git", args, {cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim()

let cached
function resolveAppTrack({env = process.env, run = git} = {}) {
  const named = env.MENTRA_APP_TRACK?.trim()
  if (named) {
    if (!TRACKS.has(named)) throw new Error(`MENTRA_APP_TRACK="${named}" must be dev or staging`)
    return named
  }
  // A CI build that names no track keeps building the Mentra App, as before.
  if (env.CI === "true" || env.CI === "1") return "staging"
  if (run === git && cached) return cached
  let track
  try {
    track = nearestTrack(run)
  } catch {
    console.warn("[app-track] origin/dev or origin/staging is missing: building the Mentra App. Set MENTRA_APP_TRACK.")
    track = "staging"
  }
  if (run === git) cached = track
  return track
}

module.exports = {resolveAppTrack}
