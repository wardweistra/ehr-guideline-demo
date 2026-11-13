// Shared helpers for the loader scripts. No dependencies beyond Node.js 18+.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const DEFAULT_REPO = process.env.GUIDELINES_REPO || 'https://github.com/wardweistra/cpg-example'
const MOUNTED = '/guidelines'

const log = (...args) => console.log(...args)
const fail = (message) => {
  console.error(`ERROR: ${message}`)
  process.exit(1)
}

// Returns the directory holding the guideline project (an IG source tree with
// an input/ folder). `source` is a local directory or a GitHub repository URL
// (optionally with #branch-or-tag); without it, the mounted /guidelines folder
// is used when it holds a project, and the default repository otherwise.
async function resolveSource(source) {
  if (!source) {
    const mounted =
      fs.existsSync(MOUNTED) && fs.readdirSync(MOUNTED).some((name) => !name.startsWith('.') && name !== 'README.md')
    source = mounted ? MOUNTED : DEFAULT_REPO
  }
  if (!/^https?:\/\//.test(source)) {
    if (!fs.existsSync(source)) fail(`Guideline directory ${source} does not exist`)
    log(`Using guideline project in ${source}`)
    return source
  }
  const [url, ref = 'HEAD'] = source.replace(/\.git$/, '').split('#')
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/)
  if (!match) fail(`Only GitHub repository URLs are supported, got ${source}`)
  const tarball = `https://github.com/${match[1]}/${match[2]}/archive/${ref}.tar.gz`
  log(`Downloading guideline project ${url} (${ref})`)
  const response = await fetch(tarball)
  if (!response.ok) fail(`Cannot download ${tarball} (HTTP ${response.status})`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guidelines-'))
  const archive = path.join(dir, 'source.tar.gz')
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
  execFileSync('tar', ['-xzf', archive, '-C', dir, '--strip-components=1'])
  return dir
}

// All files below dir (recursively), sorted, skipping the given folder names.
function walk(dir, skip = []) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) return skip.includes(entry.name) ? [] : walk(file, skip)
      return [file]
    })
}

// Parses a file as a FHIR JSON resource; undefined when it is not one.
function readResource(file) {
  if (fs.statSync(file).size > 20 * 1024 * 1024) return undefined
  const text = fs.readFileSync(file, 'utf8')
  if (!text.trimStart().startsWith('{')) return undefined
  try {
    const resource = JSON.parse(text)
    return resource.resourceType ? resource : undefined
  } catch {
    return undefined
  }
}

// fetch that returns parsed JSON and fails with the server's own explanation.
async function request(url, { method = 'GET', headers = {}, body, okStatuses = [] } = {}) {
  let response
  try {
    response = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    fail(`Cannot reach ${url} (${error.cause?.code ?? error.message})`)
  }
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  if (!response.ok && !okStatuses.includes(response.status)) {
    const detail =
      json?.issue?.map((i) => i.diagnostics ?? i.details?.text).join('; ') ??
      json?.error?.message ??
      text.slice(0, 500)
    fail(`${method} ${url} returned HTTP ${response.status}: ${detail}`)
  }
  return { status: response.status, json }
}

// Waits until check() resolves to something truthy (services need a few
// minutes to start, the first time in particular).
async function waitFor(label, check, timeoutSeconds = 1800, intervalSeconds = 5) {
  const start = Date.now()
  let announced = false
  for (;;) {
    try {
      if (await check()) return
    } catch {
      // not reachable yet
    }
    if (Date.now() - start > timeoutSeconds * 1000) fail(`${label}: not ready within ${timeoutSeconds}s`)
    if (!announced) log(`Waiting for ${label} ...`)
    announced = true
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000))
  }
}

module.exports = { fail, log, readResource, request, resolveSource, waitFor, walk }
