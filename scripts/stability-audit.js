'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const failures = []
const warnings = []

function pass(label) { console.log(`PASS  ${label}`) }
function fail(label, detail) { failures.push(`${label}${detail ? `: ${detail}` : ''}`); console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
function warn(label, detail) { warnings.push(`${label}${detail ? `: ${detail}` : ''}`); console.log(`WARN  ${label}${detail ? ` — ${detail}` : ''}`) }

console.log('DARKNOTE WHOLE-CODE STABILITY AUDIT')
console.log('====================================')

// 1. JSON/config integrity
for (const file of ['package.json', 'package-lock.json', 'config.json']) {
  try { JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')); pass(`${file} is valid JSON`) }
  catch (e) { fail(`${file} is valid JSON`, e.message) }
}

// 2. Syntax-check every JavaScript source file without loading third-party deps.
const jsFiles = []
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (['node_modules', '.git'].includes(name)) continue
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walk(full)
    else if (name.endsWith('.js')) jsFiles.push(full)
  }
}
walk(ROOT)
let syntaxFailed = 0
for (const file of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (r.status !== 0) { syntaxFailed++; fail(`syntax ${path.relative(ROOT, file)}`, (r.stderr || r.stdout).trim()) }
}
if (!syntaxFailed) pass(`all ${jsFiles.length} JavaScript files pass syntax checks`)

// 3. Command registry sanity: duplicate case labels are a common silent bug.
const main = fs.readFileSync(path.join(ROOT, 'BIGBRO.js'), 'utf8')
const labels = [...main.matchAll(/\bcase\s+['"]([a-zA-Z0-9_]+)['"]\s*:/g)].map(m => m[1].toLowerCase())
const counts = new Map()
for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1)
const dupes = [...counts].filter(([, n]) => n > 1)
if (dupes.length) fail('duplicate command case labels', dupes.map(([x, n]) => `${x}×${n}`).join(', '))
else pass(`command switch has ${labels.length} unique case labels`)

// 4. Pairing lifecycle invariants.
const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')
const bot = fs.readFileSync(path.join(ROOT, 'lib', 'bot-instance.js'), 'utf8')
const pairingChecks = [
  ['pairing uses ws.isOpen/readyState fallback', /ws\?\.isOpen === true \|\| conn\.ws\?\.readyState === 1/.test(index)],
  ['pairing has a finite open deadline', /Date\.now\(\) \+ 20000/.test(index)],
  ['secondary pairing sockets do not auto-reconnect', /__darknotePairingSocket \|\| !state\.creds\.registered/.test(bot)],
  ['stale socket closes cannot mutate runtime', /currentSocket\(sessionId\) !== conn/.test(bot)],
  ['main stale socket closes are ignored', /currentSocket\(\) !== conn/.test(index)],
]
for (const [label, ok] of pairingChecks) ok ? pass(label) : fail(label)

// 5. Temporary pairing state must not be treated as completed auth.
const msg = fs.readFileSync(path.join(ROOT, 'lib', 'msg.js'), 'utf8')
const session = fs.readFileSync(path.join(ROOT, 'lib', 'session.js'), 'utf8')
if (/return creds\?\.registered === true/.test(msg) && /return Boolean\(creds && creds\.registered === true\)/.test(session)) pass('pairing state uses explicit registered flag')
else fail('pairing state uses explicit registered flag')

// 6. Runtime safety guard is installed once.
const runtime = fs.readFileSync(path.join(ROOT, 'lib', 'runtime.js'), 'utf8')
if (/if \(guardsInstalled\) return false/.test(runtime) && /process\.on\('unhandledRejection'/.test(runtime) && /process\.on\('uncaughtException'/.test(runtime)) pass('process crash guards are installed once')
else fail('process crash guards are installed once')

// 7. Dependencies referenced by source should exist in package.json (ignore Node built-ins and scoped package bases).
let pkg = {}
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) } catch {}
const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})])
const builtins = new Set(require('module').builtinModules)
const missing = new Set()
for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8')
  for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const mod = m[1]
    if (mod.startsWith('.') || mod.startsWith('/') || builtins.has(mod) || mod.startsWith('node:')) continue
    const base = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0]
    if (![...declared].some(d => d === base || d.startsWith(base + '/'))) missing.add(base)
  }
}
if (missing.size) fail('external imports declared in package.json', [...missing].join(', '))
else pass('all external imports are declared')

// 8. Test script exists; a missing npm test script is itself a stability/CI gap.
if (pkg.scripts?.test && pkg.scripts?.audit) pass('npm test and npm run audit scripts are available')
else fail('npm test and npm run audit scripts are available')

console.log('\nRESULT')
console.log('------')
if (warnings.length) console.log(`Warnings: ${warnings.length}`)
if (failures.length) {
  console.log(`FAILURES: ${failures.length}`)
  process.exitCode = 1
} else {
  console.log('PASS: static stability audit completed with no failures')
}
