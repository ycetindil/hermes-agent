/**
 * Write the desktop artifact stamp for source, bundled and Light builds.
 * bundle-electron-main.mjs bakes it into the running code. The packaged
 * sidecar exists only to detect replacement of that artifact by an update.
 * PM's bundle builder supplies relative launch paths for bundled artifacts.
 * Provenance comes from CI, local git, or an explicit unknown-source stamp.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve, join, relative, posix } from "path"
import productIdentity from "../product-identity.cjs"
import { channelBuildRequest, releaseVersion, STABLE_TAG_RE } from "../../../scripts/msix-shared.mjs"
import { validateBundleEnvironment } from "./bundle-env.mjs"
import { execFileSync } from "child_process"

import { isMain } from "./utils.mjs"

const STAMP_SCHEMA_VERSION = 1

/** All-zero placeholder used when no real commit can be resolved. */
export const FALLBACK_COMMIT = "0000000000000000000000000000000000000000"
export const FALLBACK_BRANCH = "main"

const DESKTOP_ROOT = resolve(import.meta.dirname, "..")
const REPO_ROOT = resolve(DESKTOP_ROOT, "..", "..")
const OUT_DIR = join(DESKTOP_ROOT, "build")
const OUT_FILE = join(OUT_DIR, "install-stamp.json")

function tryExec(argv, opts) {
  try {
    return execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, ...opts }).trim()
  } catch {
    return null
  }
}

export function fromCI(env = process.env) {
  const sha = env.GITHUB_SHA
  if (!sha) return null
  const branch = env.GITHUB_REF_NAME || env.GITHUB_HEAD_REF || null
  return {
    commit: sha,
    branch: branch,
    dirty: false, // CI builds from a checkout-of-ref by definition
    source: "ci"
  }
}

/** Compare two `major.minor.patch` cores numerically, like Python's tuple max. */
function compareVersionCore(a, b) {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function parseNonNegative(value) {
  if (value === null || value === undefined) return null
  const parsed = Number.parseInt(String(value).trim(), 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

/** Mirror of the CLI's `_derived_version`: `<base>+<distance>` past a release. */
function derivedVersion(baseVersion, distance, dirty, shortCommit) {
  if (distance && distance > 0) {
    const suffix = shortCommit ? `${distance}.g${shortCommit}` : String(distance)
    return `${baseVersion}+${suffix}${dirty && shortCommit ? ".dirty" : ""}`
  }
  if (dirty && distance === null) return `${baseVersion}+?`
  return baseVersion
}

/** The `[project]` version of a pyproject.toml, or null when it has none. */
function pyprojectVersion(text) {
  if (!text) return null
  const project = text.split(/^\[project\]/m)[1]
  if (!project) return null
  const match = /^\s*version\s*=\s*"([^"]+)"/m.exec(project.split(/^\[/m)[0])
  return match ? match[1] : null
}

/**
 * Resolve baseVersion / distance / displayVersion from local git, by the same
 * rules the CLI uses (hermes_cli/version_info.py _git_version_info): the
 * highest merged stable tag, else the nearest CalVer release's pyproject
 * version, else the bare `git.<short>` identity. Never throws: a git probe
 * that fails degrades to nulls, and the stamp stays honest about that.
 */
export function gitVersionInfo(repoRoot = REPO_ROOT, execFn = tryExec, { shortCommit = null, dirty = false } = {}) {
  const tags = execFn(["git", "tag", "--merged", "HEAD", "--list", "v[0-9]*"], { cwd: repoRoot })
  const releases = (tags || "")
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => STABLE_TAG_RE.test(tag))
    .map((tag) => tag.slice(1))
  let baseVersion = null
  let distance = null
  if (releases.length > 0) {
    baseVersion = releases.reduce((best, next) => (compareVersionCore(next, best) > 0 ? next : best))
    distance = parseNonNegative(execFn(["git", "rev-list", "--count", `v${baseVersion}..HEAD`], { cwd: repoRoot }))
  } else {
    // Releases before semver tags existed are tagged vYYYY.M.D only; the
    // version users actually run is in that tag's pyproject.
    const described = execFn(["git", "describe", "--tags", "--long", "--match", "v2[0-9][0-9][0-9].*", "HEAD"], { cwd: repoRoot })
    if (described) {
      const parts = described.split("-")
      parts.pop() // short commit
      const count = parts.pop()
      const tag = parts.join("-")
      const version = pyprojectVersion(execFn(["git", "show", `${tag}:pyproject.toml`], { cwd: repoRoot }))
      if (version && STABLE_TAG_RE.test(`v${version}`)) {
        baseVersion = version
        distance = parseNonNegative(count)
      }
    }
  }
  if (baseVersion === null) {
    return {
      baseVersion: null,
      distance: null,
      displayVersion: shortCommit ? `git.${shortCommit}${dirty ? ".dirty" : ""}` : null
    }
  }
  return { baseVersion, distance, displayVersion: derivedVersion(baseVersion, distance, dirty, shortCommit) }
}

export function fromLocalGit(repoRoot = REPO_ROOT, execFn = tryExec) {
  const sha = execFn(["git", "rev-parse", "HEAD"], { cwd: repoRoot })
  if (!sha) return null
  const branch = execFn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot })
  // `git status --porcelain -uno` is empty iff tracked files match HEAD.
  // We exclude untracked files (-uno) intentionally: a developer who's
  // checked out an installer scratch dir alongside the repo shouldn't
  // poison every local build with a [DIRTY] stamp.  We DO care about
  // tracked-but-modified files because those mean the .exe content
  // differs from the commit being pinned.
  const status = execFn(["git", "status", "--porcelain", "-uno"], { cwd: repoRoot })
  const dirty = status !== null && status.length > 0
  const shortCommit = execFn(["git", "rev-parse", "--short=7", "HEAD"], { cwd: repoRoot })
  return {
    commit: sha,
    branch: branch === "HEAD" ? null : branch, // detached HEAD -> null
    dirty: dirty,
    source: "local",
    // The real version at build time, resolved from local git by the CLI's
    // rules — a local build must not stamp nulls and leave the footer to
    // guess from whatever runtime happens to be installed.
    ...gitVersionInfo(repoRoot, execFn, { shortCommit, dirty })
  }
}

export function fromFallback(branch = FALLBACK_BRANCH) {
  // Non-git builds (ZIP download, bootstrap installer without a resolvable
  // HEAD) cannot determine a real commit.  Use a placeholder so local /
  // personal builds can still complete.  The desktop bootstrap treats the
  // all-zero commit as "unknown" and falls back to an unpinned branch
  // bootstrap instead of trying to fetch a non-existent GitHub commit.
  return {
    commit: FALLBACK_COMMIT,
    branch: branch || FALLBACK_BRANCH,
    dirty: false,
    source: "fallback"
  }
}

/**
 * Resolve the install stamp without writing it.  Pure enough for unit tests:
 * inject env / execFn / repoRoot to simulate CI, local git, or no-git trees.
 */
export function resolveStamp({
  env = process.env,
  repoRoot = REPO_ROOT,
  execFn = tryExec,
  fallbackBranch = FALLBACK_BRANCH
} = {}) {
  const channelBuild = channelBuildRequest(env)
  if (channelBuild) {
    const local = fromLocalGit(repoRoot, execFn)
    if (!local || local.commit !== channelBuild.commit || local.dirty) throw new Error('Channel build identity does not match clean checkout HEAD')
    return { ...local, branch: null, source: 'channel-build', baseVersion: channelBuild.sourceVersion, distance: null, displayVersion: null, channelBuild }
  }
  if (env.HERMES_BUILD_COMMIT) {
    if (!/^[a-f0-9]{40}$/.test(env.HERMES_BUILD_COMMIT) || env.HERMES_PAYLOAD_TAG) {
      throw new Error('Commit builds require an exact full SHA without a release tag')
    }
    const local = fromLocalGit(repoRoot, execFn)
    if (!local || local.commit !== env.HERMES_BUILD_COMMIT) {
      throw new Error('Commit build identity does not match the checkout HEAD')
    }
    return { ...local, branch: null, source: 'commit-build' }
  }
  return fromCI(env) || fromLocalGit(repoRoot, execFn) || fromFallback(fallbackBranch)
}

export function isFallbackCommit(commit) {
  return typeof commit === "string" && /^0{7,40}$/.test(commit)
}

/** Qualify desktop CLI files before the immutable runtime paths are baked.
 * Canonical command keys remain stable for backend consumers; public aliases
 * come from the declared filenames, never those internal keys. The canonical
 * files stay beside them: the agent's own terminal puts <payload>/bin first on
 * PATH (pm.environments.activate_dependencies) and runs bare `hermes`, while
 * only the qualified names are published (MSIX aliases, ~/.local/bin links).
 */
export function stageDesktopLaunchers(root, identity = productIdentity) {
  const file = join(root, 'manifest.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const windows = manifest.target.startsWith('win32')
  const commands = {}
  const launchers = []
  for (const [name, source] of Object.entries(manifest.runtime.commands)) {
    const alias = name.replace(/^hermes(?=-|$)/, identity.cliName)
    const destination = posix.join(posix.dirname(source), `${alias}${windows ? '.exe' : ''}`)
    if (source !== destination && existsSync(join(root, source))) {
      copyFileSync(join(root, source), join(root, destination))
    }
    if (!existsSync(join(root, destination))) throw new Error(`Missing desktop launcher: ${destination}`)
    commands[name] = destination
    launchers.push(alias)
  }
  manifest.runtime.commands = commands
  manifest.launchers = launchers
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

/** Electron and the embedded CLI must see the same immutable provenance. */
export function writeDesktopStamp(outDir, built) {
  const json = JSON.stringify(built, null, 2) + "\n"
  mkdirSync(outDir, { recursive: true })
  if (built.payload === 'bundled') {
    writeFileSync(join(outDir, 'agent-payload', built.runtime.repoDir, 'install-stamp.json'), json, 'utf8')
  }
  writeFileSync(join(outDir, 'install-stamp.json'), json, 'utf8')
}

function main() {
  const stamp = resolveStamp()
  if (!stamp || !stamp.commit) {
    // Should not happen — fromFallback() always provides a commit.
    console.error(
      "[write-build-stamp] ERROR: could not determine git commit.\n" +
        "  - $GITHUB_SHA not set\n" +
        "  - `git rev-parse HEAD` failed at " +
        REPO_ROOT +
        "\n" +
        "Packaged builds require a git ref to pin first-launch install.ps1\n" +
        "against. Run from a git checkout or set $GITHUB_SHA explicitly."
    )
    process.exit(1)
  }

  if (isFallbackCommit(stamp.commit)) {
    console.warn(
      "[write-build-stamp] WARNING: no git commit found (non-git checkout?).\n" +
        "  Using placeholder commit — the packaged app will fall back to the\n" +
        "  default branch for first-launch bootstrap.  For production builds,\n" +
        "  run from a git checkout or set $GITHUB_SHA."
    )
  }

  if (stamp.dirty) {
    console.warn(
      "[write-build-stamp] WARNING: working tree is dirty.\n" +
        "  Pinning to " +
        stamp.commit.slice(0, 12) +
        " but the packaged code may differ from that commit.\n" +
        "  Commit your changes before publishing this build."
    )
  }

  const bundled = ['bundled', 'store'].includes(process.env.HERMES_DESKTOP_VARIANT)
  const payload = bundled
    ? stageDesktopLaunchers(join(OUT_DIR, 'agent-payload'))
    : null
  const built = buildStampPayload(stamp, process.env, process.platform, payload)
  writeDesktopStamp(OUT_DIR, built)
  console.log(
    "[write-build-stamp] wrote " +
      relative(REPO_ROOT, OUT_FILE) +
      " -> " +
      stamp.commit.slice(0, 12) +
      (stamp.branch ? " (" + stamp.branch + ")" : "") +
      (stamp.dirty ? " [DIRTY]" : "") +
      (stamp.source === "fallback" ? " [FALLBACK]" : "")
  )
}

/** One artifact schema for source, bundled and Light builds.
 * The PM bundle builder supplies launch paths only for bundled artifacts.
 */
export function buildStampPayload(stamp, env = process.env, platform = process.platform, payload = null) {
  const variant = (env.HERMES_DESKTOP_VARIANT || "").trim()
  const channelBuild = channelBuildRequest(env)
  if (channelBuild && (stamp.commit !== channelBuild.commit || stamp.dirty)) throw new Error('Channel build identity does not match stamp')
  const commitBuild = env.HERMES_BUILD_COMMIT || null
  if (commitBuild && (!/^[a-f0-9]{40}$/.test(commitBuild) || commitBuild !== stamp.commit)) {
    throw new Error('Commit build identity does not match the stamp commit')
  }
  if (commitBuild && env.HERMES_PAYLOAD_TAG) {
    throw new Error('Commit builds cannot also set a release tag')
  }
  const version = env.HERMES_PAYLOAD_VERSION || releaseVersion(env.HERMES_PAYLOAD_TAG) || null
  // The bundle's baked runtime defaults/clears, recorded as data so the smoke
  // driver can predict the app's resolved Hermes home without reimplementing
  // the banner. Only commit bundles carry one, but the field is harmless when
  // absent elsewhere.
  const bundleEnv = env.HERMES_BUNDLE_ENV_JSON ? validateBundleEnvironment(JSON.parse(env.HERMES_BUNDLE_ENV_JSON)) : undefined
  const base = {
    schemaVersion: STAMP_SCHEMA_VERSION,
    commit: stamp.commit,
    branch: commitBuild || channelBuild ? null : stamp.branch,
    builtAt: new Date().toISOString(),
    dirty: stamp.dirty,
    source: channelBuild ? 'channel-build' : commitBuild ? 'commit-build' : stamp.source,
    commitDate: stamp.commitDate ?? null,
    // An explicit payload version is the release authority and wins over the
    // git-derived stamp fields; the git resolution is the fallback that keeps
    // local builds from stamping nulls.
    baseVersion: channelBuild?.sourceVersion ?? version?.split('-')[0] ?? stamp.baseVersion ?? null,
    displayVersion: channelBuild
      ? `${channelBuild.sourceVersion} (${channelBuild.channel} #${channelBuild.sequence}, ${channelBuild.commit.slice(0, 7)})`
      : version ?? stamp.displayVersion,
    distance: stamp.distance ?? null
  }

  if (channelBuild) base.channelBuild = channelBuild
  // Rehearsal receivers use the real stable update path, never preview resolution.
  if (channelBuild?.receiverCandidate) {
    delete base.channelBuild
    base.source = 'build'
    base.displayVersion = channelBuild.version
  }
  if (variant === 'bundled') base.receiverProtocol = 1

  const updateMechanism = {
    '': 'self',
    bootstrap: 'self',
    store: 'microsoft-store',
    bundled: { win32: 'app-installer', darwin: 'electron-updater' }[platform] || 'external',
    light: platform === 'darwin' ? 'electron-updater' : 'external'
  }[variant]
  if (!updateMechanism) throw new Error(`Unknown desktop variant: ${variant}`)
  if (channelBuild && updateMechanism === 'external') throw new Error('Channel builds require a supported native update owner')
  const bundled = variant === 'bundled' || variant === 'store'
  if (bundled && !payload?.runtime?.commands?.hermes) {
    throw new Error('PM payload has no completed launch contract; stage the bundle before packaging')
  }
  return {
    ...base,
    payload: variant === "store" ? "bundled" : variant || "bootstrap",
    distribution: "desktop-app",

    updateMechanism: commitBuild ? 'external' : updateMechanism,
    tag: channelBuild?.receiverCandidate ? channelBuild.releaseTag : env.HERMES_PAYLOAD_TAG || null,
    ...(bundleEnv ? { bundleEnv } : {}),
    ...(bundled ? { runtime: payload.runtime } : {})
  }
}

if (isMain(import.meta.url)) {
  main()
}

