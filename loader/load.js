#!/usr/bin/env node
// Loads a guideline project into the demo: its guidelines into the CDS service
// and its test patients into the EHR.
//
// Usage: node load.js [all | guidelines | patients] [source]
//   source: a directory or https://github.com/owner/repo[#branch-or-tag];
//           default: the mounted /guidelines folder, or else GUIDELINES_REPO
'use strict'

const { fail, resolveSource } = require('./lib')
const { loadGuidelines } = require('./load-guidelines')
const { loadPatients } = require('./load-patients')

async function main() {
  const [what = 'all', source] = process.argv.slice(2)
  if (!['all', 'guidelines', 'patients'].includes(what)) {
    fail(`Unknown command "${what}". Usage: load.js [all | guidelines | patients] [source]`)
  }
  const dir = await resolveSource(source)
  if (what !== 'patients') await loadGuidelines(dir)
  if (what !== 'guidelines') await loadPatients(dir)
}

main().catch((error) => fail(error.stack ?? error.message))
