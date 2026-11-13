// Loads the guidelines of a FHIR/CQL (CPG) project into the CDS service: a
// HAPI FHIR server with clinical reasoning and CDS Hooks enabled. HAPI then
// offers every PlanDefinition as a CDS Hooks service on /cds-services.
//
// The project is read from source (its input/ folder), so the IG does not have
// to be built first:
//  - Libraries get their CQL (input/cql/<Name>.cql) embedded; HAPI compiles it.
//  - Libraries get their dataRequirement filled from HAPI's $data-requirements,
//    which HAPI turns into the prefetch templates of the CDS service.
//  - PlanDefinitions without a CDS Hooks trigger get one (DEFAULT_HOOK), since
//    HAPI only publishes PlanDefinitions that say which hook they belong to.
//
// Loading is idempotent (PUT by id); re-run it after changing a guideline.
//
// Environment: CDS_URL (default http://cds:8080), DEFAULT_HOOK (default patient-view)
'use strict'

const fs = require('fs')
const path = require('path')
const { fail, log, readResource, request, waitFor, walk } = require('./lib')

const CDS_URL = (process.env.CDS_URL || 'http://cds:8080').replace(/\/$/, '')
const FHIR_URL = `${CDS_URL}/fhir`
const DEFAULT_HOOK = process.env.DEFAULT_HOOK || 'patient-view'

// Loaded in this order, so that references resolve when a resource arrives.
const TYPES = ['CodeSystem', 'ValueSet', 'ConceptMap', 'Library', 'ActivityDefinition', 'Questionnaire', 'PlanDefinition']

// By default HAPI derives a prefetch query per data requirement, like
// "ServiceRequest?patient=Patient/{{context.patientId}}&code=<codes of the value set>".
// For these types the query is stated explicitly instead (cqf-fhirQueryPattern):
const QUERY_PATTERN = 'http://hl7.org/fhir/StructureDefinition/cqf-fhirQueryPattern'
const QUERY_PATTERNS = {
  // HAPI's own "Patient?_id=Patient/<id>" is not a valid search and finds nothing in OpenMRS
  Patient: 'Patient?_id={{context.patientId}}',
}
const FHIR_JSON = { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' }

async function put(label, resources) {
  if (resources.length === 0) return
  const bundle = {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: resources.map((resource) => ({
      resource,
      request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` },
    })),
  }
  const { json } = await request(FHIR_URL, { method: 'POST', headers: FHIR_JSON, body: bundle })
  log(`${label}:`)
  for (const entry of json.entry) log(`  ${entry.response.status.padEnd(12)} ${entry.response.location.replace(/\/_history.*/, '')}`)
}

function collect(dir) {
  const input = path.join(dir, 'input')
  const root = fs.existsSync(input) ? input : dir
  const skip = ['tests', 'examples', 'images', 'includes', 'pagecontent', 'node_modules', 'output', 'temp', 'fsh-generated']
  const files = walk(root, skip)

  const resources = files
    .map(readResource)
    .filter((r) => r && TYPES.includes(r.resourceType))
  for (const r of resources) if (!r.id) fail(`${r.resourceType} ${r.url ?? r.name ?? ''} has no id`)

  // CQL by library name, e.g. "library DailyAppleLogic version '1.0.0'"
  const cql = new Map()
  for (const file of files.filter((f) => f.endsWith('.cql'))) {
    const text = fs.readFileSync(file, 'utf8')
    const header = text.match(/^\s*library\s+"?([\w.]+)"?(?:\s+version\s+'([^']+)')?/m)
    if (header) cql.set(header[1], { text, version: header[2] })
  }
  return { resources, cql }
}

// Embeds the CQL in its Library, and creates a Library for CQL that has none.
function embedCql(resources, cql) {
  const libraries = resources.filter((r) => r.resourceType === 'Library')
  for (const library of libraries) {
    const source = cql.get(library.name) ?? cql.get(library.id)
    const hasContent = library.content?.some((c) => c.data || c.url)
    if (source && !hasContent) {
      library.content = [{ contentType: 'text/cql', data: Buffer.from(source.text).toString('base64') }]
    }
  }
  const canonicalBase = libraries.map((l) => l.url?.match(/^(.*)\/Library\//)?.[1]).find(Boolean)
  for (const [name, source] of cql) {
    // FHIRHelpers ships with the CQL engine
    if (name === 'FHIRHelpers' || libraries.some((l) => l.name === name || l.id === name)) continue
    resources.push({
      resourceType: 'Library',
      id: name,
      ...(canonicalBase ? { url: `${canonicalBase}/Library/${name}` } : {}),
      name,
      ...(source.version ? { version: source.version } : {}),
      status: 'active',
      type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/library-type', code: 'logic-library' }] },
      content: [{ contentType: 'text/cql', data: Buffer.from(source.text).toString('base64') }],
    })
  }
}

// HAPI derives a CDS service's prefetch templates from the dataRequirement of
// the PlanDefinition's Library. The IG publisher normally fills that in; here
// HAPI works it out from the CQL.
async function addDataRequirements(libraries) {
  const updated = []
  for (const library of libraries.filter((l) => l.content?.some((c) => c.contentType === 'text/cql'))) {
    const { json } = await request(`${FHIR_URL}/Library/${library.id}/$data-requirements`, { headers: FHIR_JSON })
    if (!json.dataRequirement?.length) continue
    const dataRequirement = json.dataRequirement.map((requirement) => {
      const pattern = QUERY_PATTERNS[requirement.type]
      return pattern ? { ...requirement, extension: [{ url: QUERY_PATTERN, valueString: pattern }] } : requirement
    })
    updated.push({ ...library, dataRequirement })
  }
  await put('Libraries, with data requirements', updated)
}

function makeHookable(planDefinition) {
  const actions = planDefinition.action ?? []
  if (actions.length === 0) return
  const hasHook = actions.some((a) => a.trigger?.some((t) => t.type === 'named-event' && t.name))
  if (!hasHook) {
    actions[0].trigger = [...(actions[0].trigger ?? []), { type: 'named-event', name: DEFAULT_HOOK }]
    log(`  PlanDefinition/${planDefinition.id}: no CDS Hooks trigger, added "${DEFAULT_HOOK}"`)
  }
  // The card's detail text comes from the action's description
  for (const action of actions) {
    if (!action.description && action.textEquivalent) action.description = action.textEquivalent
  }
}

async function loadGuidelines(dir) {
  log(`\n=== Guidelines -> CDS service (${CDS_URL}) ===`)
  const { resources, cql } = collect(dir)
  embedCql(resources, cql)
  if (resources.length === 0) fail(`No guideline resources found in ${dir}`)

  await waitFor(`CDS service at ${CDS_URL}`, async () => (await fetch(`${FHIR_URL}/metadata`)).ok)

  const ofType = (type) => resources.filter((r) => r.resourceType === type)
  for (const type of TYPES.filter((t) => t !== 'PlanDefinition')) await put(`${type} resources`, ofType(type))
  await addDataRequirements(ofType('Library'))

  const planDefinitions = ofType('PlanDefinition')
  log('Preparing PlanDefinitions for CDS Hooks:')
  planDefinitions.forEach(makeHookable)
  // HAPI (re)builds a CDS service when its PlanDefinition changes (it checks
  // every 10 seconds), not when its Library does. So remove the PlanDefinitions,
  // wait for their services to go, and add them again: the services then match
  // the CQL that was just loaded.
  const offered = async () => (await request(`${CDS_URL}/cds-services`)).json?.services ?? []
  const ids = planDefinitions.map((p) => p.id)
  await request(FHIR_URL, {
    method: 'POST',
    headers: FHIR_JSON,
    body: {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: ids.map((id) => ({ request: { method: 'DELETE', url: `PlanDefinition/${id}` } })),
    },
  })
  await waitFor('HAPI to retire the previous CDS services', async () => !(await offered()).some((s) => ids.includes(s.id)), 60, 1)
  await put('PlanDefinition resources', planDefinitions)
  await waitFor(
    'HAPI to publish the CDS services (if this fails, see: docker compose logs cds)',
    async () => {
      const services = await offered()
      return ids.every((id) => services.some((s) => s.id === id))
    },
    60,
    1,
  )

  const services = await offered()
  log(`\nCDS services offered by ${CDS_URL}/cds-services:`)
  for (const s of services) {
    log(`  ${s.hook.padEnd(14)} ${s.id.padEnd(34)} ${s.title ?? ''}`)
    for (const template of Object.values(s.prefetch ?? {})) log(`${' '.repeat(17)}prefetch: ${template}`)
  }
}

module.exports = { loadGuidelines }
