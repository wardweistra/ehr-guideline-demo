// Loads the test patients of a guideline project into the EHR (OpenMRS).
//
// The test data is FHIR, but OpenMRS does not store FHIR: it has its own data
// model (patients, encounters, orders, a concept dictionary) with its own REST
// API. So every resource is translated, the way an integration engine would:
//
//   Patient           -> patient, found again by its "FHIR ID" identifier
//   MedicationRequest -> drug order   (for the concept that maps to the coding)
//   ServiceRequest    -> test order   (idem)
//   codings           -> concepts in the OpenMRS dictionary, mapped to the code
//
// Only what OpenMRS can express is loaded. It has orders, but no proposals and
// no "do not perform" orders, so those are reported and skipped. Afterwards the
// EHR's FHIR API shows what a CDS service gets to see.
//
// Loading is repeatable: a test patient that already exists gets its orders
// replaced, which also resets it after a demo.
//
// Environment: EHR_URL (default http://ehr/openmrs), EHR_USER, EHR_PASSWORD,
//              EHR_PUBLIC_URL (for the links that are printed), CODESYSTEMS_DIR
'use strict'

const fs = require('fs')
const path = require('path')
const { fail, log, readResource, request, waitFor, walk } = require('./lib')

const EHR_URL = (process.env.EHR_URL || 'http://ehr/openmrs').replace(/\/$/, '')
const REST = `${EHR_URL}/ws/rest/v1`
// Sent with every request: the login at first, the session cookie after that
const AUTH = {
  Authorization: `Basic ${Buffer.from(`${process.env.EHR_USER || 'admin'}:${process.env.EHR_PASSWORD || 'Admin123'}`).toString('base64')}`,
}
const CODESYSTEMS_DIR = process.env.CODESYSTEMS_DIR || '/codesystems'
const FHIR_ID_TYPE = 'FHIR ID'
const SAME_AS = '35543629-7d8c-11e1-909d-c80aa9edcf4e' // concept map type SAME-AS

// OpenMRS now and then fails a request with an internal error (HTTP 500) when
// requests follow each other quickly; the request then had no effect and
// succeeds when repeated.
let retries = 0
async function rest(method, url, body, okStatuses = []) {
  for (let attempt = 1; ; attempt++) {
    const last = attempt === 5
    const response = await request(`${REST}${url}`, { method, headers: AUTH, body, okStatuses: last ? okStatuses : [...okStatuses, 500] })
    if (response.status !== 500 || last) return response
    retries++
    await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
  }
}
const get = async (url) => (await rest('GET', url)).json
const post = async (url, body) => (await rest('POST', url, body)).json
const query = (params) => new URLSearchParams(params).toString()

// ------------------------------------------------------------- test data --

// Groups the project's test resources per patient: { patient, resources }.
// The test cases (input/tests) are the source; the example bundles
// (input/examples) are generated from them and only used when there are no tests.
function collectPatients(dir) {
  const read = (root) =>
    walk(root, ['node_modules', 'results'])
      .map(readResource)
      .filter(Boolean)
      .flatMap((r) => (r.resourceType === 'Bundle' ? (r.entry ?? []).map((e) => e.resource).filter(Boolean) : [r]))
  const input = path.join(dir, 'input')
  const roots = fs.existsSync(input) ? [path.join(input, 'tests'), path.join(input, 'examples')] : [dir]
  const resources = roots.map(read).find((found) => found.some((r) => r.resourceType === 'Patient')) ?? []

  const patientIdOf = (r) => (r.subject ?? r.patient)?.reference?.match(/Patient\/([^/]+)$/)?.[1]
  const patients = new Map()
  for (const r of resources.filter((r) => r.resourceType === 'Patient' && r.id)) {
    if (!patients.has(r.id)) patients.set(r.id, { patient: r, resources: new Map() })
  }
  for (const r of resources.filter((r) => r.resourceType !== 'Patient')) {
    // Ids are only unique per patient, as test cases reuse them
    patients.get(patientIdOf(r))?.resources.set(`${r.resourceType}/${r.id}`, r)
  }
  return [...patients.values()].map((p) => ({ patient: p.patient, resources: [...p.resources.values()] }))
}

// ------------------------------------------------------------ terminology --

// FHIR code system URL -> name of the OpenMRS concept source, from the same
// configuration files that tell OpenMRS which URL to use in its FHIR API.
function readCodeSystems() {
  const systems = new Map([
    // Configured in the OpenMRS reference application itself
    ['http://snomed.info/sct', 'SNOMED CT'],
    ['http://loinc.org', 'LOINC'],
    ['https://cielterminology.org', 'CIEL'],
  ])
  for (const file of walk(CODESYSTEMS_DIR).filter((f) => f.endsWith('.csv'))) {
    const [header, ...rows] = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim())
    const columns = header.split(',').map((c) => c.trim().toLowerCase())
    for (const row of rows) {
      const cells = row.split(',').map((c) => c.trim())
      const name = cells[columns.indexOf('concept source')]
      const url = cells[columns.indexOf('url')]
      if (name && url) systems.set(url, name)
    }
  }
  return systems
}

class Dictionary {
  constructor(codeSystems, metadata) {
    this.codeSystems = codeSystems
    this.metadata = metadata
    this.sources = new Map()
    this.concepts = new Map()
  }

  async source(name) {
    if (!this.sources.has(name)) {
      const found = (await get(`/conceptsource?${query({ q: name, v: 'custom:(uuid,name)' })}`)).results.find((s) => s.name === name)
      this.sources.set(name, found?.uuid)
    }
    return this.sources.get(name)
  }

  // The OpenMRS concept for a FHIR CodeableConcept; created (with a mapping to
  // the code) when the dictionary has none yet. Undefined, with the reason in
  // `problems`, when none of the codings is in a code system the EHR knows.
  async concept(codeableConcept, conceptClass, problems) {
    const codings = (codeableConcept?.coding ?? []).filter((c) => c.system && c.code)
    const known = codings.filter((c) => this.codeSystems.has(c.system))
    if (known.length === 0) {
      const systems = codings.map((c) => c.system).join(', ') || 'no coding'
      problems.push(`code system not known to the EHR (${systems}); add it to ehr/backend/openmrs_config and restart the backend`)
      return undefined
    }
    const coding = known[0]
    const key = `${coding.system}|${coding.code}`
    if (this.concepts.has(key)) return this.concepts.get(key)

    const sourceName = this.codeSystems.get(coding.system)
    const sourceUuid = await this.source(sourceName)
    if (!sourceUuid) {
      problems.push(`concept source "${sourceName}" does not exist in the EHR (yet); restart the backend after adding it`)
      return undefined
    }
    const existing = (await get(`/concept?${query({ source: sourceName, code: coding.code, v: 'custom:(uuid,display)' })}`)).results[0]
    let uuid = existing?.uuid
    if (!uuid) {
      const terms = await get(`/conceptreferenceterm?${query({ source: sourceName, codeOrName: coding.code, v: 'custom:(uuid,code)' })}`)
      const term =
        terms.results.find((t) => t.code === coding.code) ??
        (await post('/conceptreferenceterm', { code: coding.code, name: coding.display ?? coding.code, conceptSource: sourceUuid }))
      const display = coding.display ?? codeableConcept.text ?? coding.code
      // Concept names are unique in OpenMRS; fall back to a name that includes the code
      for (const name of [display, `${display} (${sourceName} ${coding.code})`]) {
        const body = {
          names: [{ name, locale: 'en', conceptNameType: 'FULLY_SPECIFIED' }],
          datatype: this.metadata.datatypeNA,
          conceptClass: this.metadata.conceptClasses[conceptClass] ?? this.metadata.conceptClasses.Misc,
          mappings: [{ conceptReferenceTerm: term.uuid, conceptMapType: SAME_AS }],
        }
        const created = await rest('POST', '/concept', body, [400])
        uuid = created.json?.uuid
        if (uuid) {
          log(`    new concept "${name}" for ${key}`)
          break
        }
      }
      if (!uuid) {
        problems.push(`could not create a concept for ${key}`)
        return undefined
      }
    }
    this.concepts.set(key, uuid)
    return uuid
  }
}

// --------------------------------------------------------------- metadata --

// The OpenMRS configuration that new patients and orders have to refer to.
async function readMetadata() {
  const byName = (list, ...names) => names.map((n) => list.find((x) => (x.name ?? x.display) === n)).find(Boolean) ?? list[0]
  const list = async (resource, params = {}) =>
    (await get(`/${resource}?${query({ v: 'custom:(uuid,name,display)', limit: 100, ...params })}`)).results

  const session = await get('/session')
  if (!session.authenticated) fail(`Cannot log in to the EHR at ${EHR_URL} as ${process.env.EHR_USER || 'admin'}`)
  const provider = session.currentProvider ?? (await list('provider', { user: session.user.uuid }))[0]
  if (!provider) fail(`The EHR user ${session.user.display} is not a provider, so cannot place orders`)

  const identifierTypes = (await get('/patientidentifiertype?v=custom:(uuid,name,required)')).results
  const primaryIdType = identifierTypes.find((t) => t.required) ?? byName(identifierTypes, 'OpenMRS ID')
  const fhirIdType =
    identifierTypes.find((t) => t.name === FHIR_ID_TYPE) ??
    (await post('/patientidentifiertype', {
      name: FHIR_ID_TYPE,
      description: 'Id of the FHIR Patient resource this patient was loaded from (guideline test data)',
    }))
  const idSources = (await get('/idgen/identifiersource?v=custom:(uuid,name,identifierType:(uuid))')).results
  const idSource = idSources.find((s) => s.identifierType.uuid === primaryIdType.uuid)
  if (!idSource) fail(`The EHR has no identifier generator for ${primaryIdType.name}`)

  const orderConfig = await get('/orderentryconfig')
  const classes = await list('conceptclass')
  return {
    provider: provider.uuid,
    primaryIdType: primaryIdType.uuid,
    fhirIdType: fhirIdType.uuid,
    idSource: idSource.uuid,
    location: (await list('location', { tag: 'Login Location' }))[0]?.uuid ?? (await list('location'))[0].uuid,
    encounterType: byName(await list('encountertype'), 'Order', 'Consultation', 'Visit Note').uuid,
    encounterRole: byName(await list('encounterrole'), 'Clinician', 'Unknown').uuid,
    careSetting: byName(await list('caresetting', { v: 'custom:(uuid,display)' }), 'Outpatient').uuid,
    dispensingUnit: byName(orderConfig.drugDispensingUnits, 'Each', 'Unit', 'Piece', 'Tablet')?.uuid,
    datatypeNA: byName(await list('conceptdatatype'), 'N/A').uuid,
    conceptClasses: Object.fromEntries(classes.map((c) => [c.name, c.uuid])),
  }
}

// --------------------------------------------------------------- patients --

async function findPatient(fhirId, metadata) {
  const found = await get(`/patient?${query({ identifier: fhirId, v: 'custom:(uuid,identifiers:(identifier,identifierType:(uuid)))' })}`)
  return found.results.find((p) =>
    p.identifiers.some((i) => i.identifier === fhirId && i.identifierType.uuid === metadata.fhirIdType),
  )?.uuid
}

async function createPatient(patient, metadata) {
  const name = patient.name?.find((n) => n.use === 'official') ?? patient.name?.[0] ?? {}
  const gender = { male: 'M', female: 'F', other: 'O', unknown: 'U' }[patient.gender] ?? 'U'
  const { identifier } = await post(`/idgen/identifiersource/${metadata.idSource}/identifier`, {})
  const created = await post('/patient', {
    person: {
      names: [{ givenName: name.given?.[0] ?? patient.id, middleName: name.given?.[1], familyName: name.family ?? 'Test' }],
      gender,
      ...(patient.birthDate ? { birthdate: patient.birthDate } : { age: 40 }),
    },
    identifiers: [
      { identifier, identifierType: metadata.primaryIdType, location: metadata.location, preferred: true },
      { identifier: patient.id, identifierType: metadata.fhirIdType, location: metadata.location },
    ],
  })
  return created.uuid
}

// Removes what an earlier load (or a demo) left behind, so the patient ends up as the test data says.
async function removeOrders(patientUuid) {
  const orders = (await get(`/order?${query({ patient: patientUuid, v: 'custom:(uuid)', limit: 100 })}`)).results // active orders
  for (const order of orders) {
    await rest('DELETE', `/order/${order.uuid}?${query({ reason: 'Test data reloaded' })}`) // voids the order
  }
  return orders.length
}

// "1 apple, 1 x per d" from the structured FHIR dosage, when there is no text
function dosageText(medicationRequest) {
  const dosage = medicationRequest.dosageInstruction?.[0]
  if (!dosage) return 'As directed'
  if (dosage.text) return dosage.text
  const dose = dosage.doseAndRate?.[0]?.doseQuantity
  const repeat = dosage.timing?.repeat
  const parts = [
    dose && `${dose.value} ${dose.unit ?? dose.code ?? ''}`.trim(),
    repeat?.frequency && `${repeat.frequency} x per ${repeat.period === 1 ? '' : `${repeat.period} `}${repeat.periodUnit}`,
  ].filter(Boolean)
  return parts.join(', ') || 'As directed'
}

// Why a FHIR request cannot become an OpenMRS order (undefined when it can)
function notAnOrder(r) {
  if (r.doNotPerform) return 'doNotPerform: OpenMRS cannot record an order not to do something'
  if (!['order', 'original-order', 'filler-order', 'instance-order'].includes(r.intent)) {
    return `intent "${r.intent}": OpenMRS only has orders`
  }
  if (r.status !== 'active') return `status "${r.status}": only active orders are loaded`
  return undefined
}

async function loadPatient({ patient, resources }, metadata, dictionary) {
  let uuid = await findPatient(patient.id, metadata)
  if (uuid) {
    const removed = await removeOrders(uuid)
    log(`  Patient/${patient.id}: exists${removed ? `, ${removed} earlier order(s) removed` : ''}`)
  } else {
    uuid = await createPatient(patient, metadata)
    log(`  Patient/${patient.id}: created`)
  }

  const skipped = []
  let encounter
  for (const r of resources) {
    const label = `${r.resourceType}/${r.id}`
    const isMedication = r.resourceType === 'MedicationRequest'
    if (!isMedication && r.resourceType !== 'ServiceRequest') {
      skipped.push(`${label}: ${r.resourceType} resources are not supported by this loader`)
      continue
    }
    const problems = [notAnOrder(r)].filter(Boolean)
    const concept =
      problems.length === 0 &&
      (await dictionary.concept(isMedication ? r.medicationCodeableConcept : r.code, isMedication ? 'Drug' : 'Test', problems))
    if (isMedication && !r.medicationCodeableConcept && problems.length === 0) problems.push('medicationReference is not supported')
    if (problems.length > 0 || !concept) {
      skipped.push(`${label}: ${problems.join('; ')}`)
      continue
    }
    // Orders are placed in an encounter
    encounter ??= (
      await post('/encounter', {
        patient: uuid,
        encounterType: metadata.encounterType,
        location: metadata.location,
        encounterProviders: [{ provider: metadata.provider, encounterRole: metadata.encounterRole }],
      })
    ).uuid
    const order = { patient: uuid, concept, encounter, orderer: metadata.provider, careSetting: metadata.careSetting, urgency: 'ROUTINE' }
    if (isMedication) {
      await post('/order', {
        ...order,
        type: 'drugorder',
        dosingType: 'org.openmrs.FreeTextDosingInstructions',
        // The order is for a concept, not for a product from the EHR's drug list;
        // the instructions name it, as the chart shows product names only
        dosingInstructions: `${r.medicationCodeableConcept.text ?? r.medicationCodeableConcept.coding?.[0]?.display ?? 'Medication'}: ${dosageText(r)}`,
        quantity: 1,
        quantityUnits: metadata.dispensingUnit,
        numRefills: 0,
      })
    } else {
      await post('/order', { ...order, type: 'testorder' })
    }
    log(`    ${label} -> ${isMedication ? 'drug' : 'test'} order`)
  }
  for (const reason of skipped) log(`    skipped ${reason}`)
  return { uuid, skipped: skipped.length }
}

async function loadPatients(dir) {
  log(`\n=== Test patients -> EHR (${EHR_URL}) ===`)
  const patients = collectPatients(dir)
  if (patients.length === 0) return log(`No test patients found in ${dir}`)

  await waitFor(`EHR at ${EHR_URL} (the first start takes several minutes)`, async () => {
    const response = await fetch(`${REST}/session`, { headers: AUTH, redirect: 'manual' })
    if (!response.ok || !(await response.json()).authenticated) return false
    // Work in one session from here on. Logging in again for every request is
    // not only slower: OpenMRS then regularly fails requests with an internal error.
    const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    if (cookie) {
      delete AUTH.Authorization
      AUTH.Cookie = cookie
    }
    return true
  })
  const metadata = await readMetadata()
  const dictionary = new Dictionary(readCodeSystems(), metadata)

  let skipped = 0
  const loaded = []
  for (const p of patients) {
    const result = await loadPatient(p, metadata, dictionary)
    skipped += result.skipped
    loaded.push({ id: p.patient.id, uuid: result.uuid })
  }
  if (process.env.DEBUG) log(`(${retries} request(s) repeated)`)
  log(`\n${patients.length} test patients are in the EHR${skipped ? `; ${skipped} resource(s) skipped (see above)` : ''}:`)
  const publicUrl = process.env.EHR_PUBLIC_URL || 'http://localhost:8081/openmrs'
  for (const p of loaded) log(`  ${p.id.padEnd(30)} ${publicUrl}/spa/patient/${p.uuid}/chart`)
}

module.exports = { loadPatients }
