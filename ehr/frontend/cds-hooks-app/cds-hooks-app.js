// CDS Hooks client for OpenMRS 3: lets an administrator register CDS services
// and shows their cards when a clinician opens a patient chart (patient-view).
//
// This is a frontend module for the OpenMRS 3 app shell, written as one plain
// script so that it needs no build. The app shell loads the modules listed in
// its import map as Webpack "module federation" containers: a global object
// with init() and get(). get('./start') returns the module's exports, and each
// export named in routes.json returns single-spa lifecycle functions
// (bootstrap, mount, unmount) that render into a DOM element.
//
// Configuration is kept in the OpenMRS system setting "cdshooks.configuration".
// CDS services are called through the EHR's relay (see ehr/edge/nginx.conf), as
// CDS Hooks calls are made by the EHR's server, not by the browser.
;(function () {
  'use strict'

  const MODULE_NAME = '@guideline-demo/esm-cds-hooks-app'
  const SETTING = 'cdshooks.configuration'
  const SUPPORTED_HOOKS = ['patient-view']
  const DEFAULT_CONFIG = {
    // How CDS services reach this EHR's FHIR API ("ehr" is the edge proxy in docker-compose.yml)
    fhirServer: 'http://ehr/openmrs/ws/fhir2/R4',
    // true: the EHR runs the prefetch queries and sends the data along with the hook;
    // false: the CDS service queries the FHIR API itself, with the access token it is given
    sendPrefetch: true,
    endpoints: [], // [{ url, services: [{ id, hook, title, description, prefetch, enabled }] }]
  }

  const base = () => window.openmrsBase || '/openmrs'

  // ---------------------------------------------------------------- helpers --

  // h('div', { class: 'x', onclick: fn }, child, ...) creates a DOM element.
  function h(tag, attributes, ...children) {
    const element = document.createElement(tag)
    for (const [name, value] of Object.entries(attributes || {})) {
      if (value === undefined || value === null || value === false) continue
      if (name.startsWith('on')) element.addEventListener(name.slice(2), value)
      else if (name in element && name !== 'list' && name !== 'form') element[name] = value
      else element.setAttribute(name, value === true ? '' : value)
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue
      element.append(child.nodeType ? child : document.createTextNode(String(child)))
    }
    return element
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    })
    const text = await response.text()
    let json
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    if (!response.ok) {
      const detail = json?.error?.message || json?.issue?.[0]?.diagnostics || text.slice(0, 200)
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return json
  }

  const rest = (path, options) => fetchJson(`${base()}/ws/rest/v1${path}`, options)

  // CDS services are reached via the EHR's relay: /openmrs/cds-hooks-relay/<scheme>/<host>/<path>
  const relay = (url, options) => fetchJson(`${base()}/cds-hooks-relay/${url.replace('://', '/')}`, options)

  // ----------------------------------------------------------- configuration --

  async function loadConfig() {
    const result = await rest(`/systemsetting?q=${SETTING}&v=custom:(uuid,property,value)`)
    const setting = result.results.find((s) => s.property === SETTING)
    let stored = {}
    try {
      stored = setting?.value ? JSON.parse(setting.value) : {}
    } catch {
      stored = {}
    }
    return { uuid: setting?.uuid, config: { ...DEFAULT_CONFIG, ...stored } }
  }

  async function saveConfig(state) {
    const body = { property: SETTING, value: JSON.stringify(state.config) }
    if (state.uuid) {
      await rest(`/systemsetting/${state.uuid}`, { method: 'POST', body: JSON.stringify({ value: body.value }) })
    } else {
      body.description = 'CDS Hooks services called by the EHR (managed on the CDS Hooks administration page)'
      state.uuid = (await rest('/systemsetting', { method: 'POST', body: JSON.stringify(body) })).uuid
    }
  }

  // --------------------------------------------------------- CDS Hooks calls --

  async function discover(url) {
    const discovery = await relay(url)
    if (!Array.isArray(discovery?.services)) throw new Error('The response is not a CDS Hooks discovery document')
    return discovery.services
  }

  // Runs one prefetch template, e.g. "MedicationRequest?subject=Patient/{{context.patientId}}",
  // against the EHR's own FHIR API.
  async function runPrefetch(template, context) {
    const filled = template.replace(/{{\s*context\.(\w+)\s*}}/g, (_, name) => String(context[name] ?? ''))
    if (filled.includes('{{')) return undefined // a token this EHR does not support
    // Encode the search parameters: codes are written as system|code, and servers refuse a bare "|"
    const [path, search] = filled.split('?')
    const query = search ? `${path}?${new URLSearchParams(search)}` : path
    return fetchJson(`${base()}/ws/fhir2/R4/${query}`, { headers: { Accept: 'application/fhir+json' } })
  }

  // Fires a hook: calls every enabled service for it and returns one result per service.
  async function fireHook(hook, context, config) {
    const session = await rest('/session')
    context = { userId: `Practitioner/${session.currentProvider?.uuid || session.user?.uuid}`, ...context }
    // The access token with which CDS services may read from the EHR's FHIR API (see ehr/edge/nginx.conf)
    const fhirAuthorization = config.fhirServer ? await fetchJson(`${base()}/cds-hooks-token`) : undefined

    const perEndpoint = await Promise.all(
      config.endpoints.map(async (endpoint) => {
        const enabled = endpoint.services.filter((s) => s.enabled && s.hook === hook)
        if (enabled.length === 0) return []
        // Ask the CDS service what it offers right now, as its services (and the
        // data they ask for) change when guidelines are reloaded
        const offered = await discover(endpoint.url).catch(() => undefined)
        return Promise.all(
          enabled.map(async (configured) => {
            const service = offered ? offered.find((s) => s.id === configured.id && s.hook === hook) : configured
            if (!service) return { service: configured, cards: [], error: 'The CDS service no longer offers this service' }
            try {
              const request = { hook, hookInstance: crypto.randomUUID(), context }
              if (config.fhirServer) Object.assign(request, { fhirServer: config.fhirServer, fhirAuthorization })
              if (config.sendPrefetch && service.prefetch) {
                request.prefetch = {}
                await Promise.all(
                  Object.entries(service.prefetch).map(async ([key, template]) => {
                    // A failed prefetch is left out; the CDS service may then fetch the data itself
                    const data = await runPrefetch(template, context).catch(() => undefined)
                    if (data) request.prefetch[key] = data
                  }),
                )
              }
              const url = `${endpoint.url.replace(/\/$/, '')}/${encodeURIComponent(service.id)}`
              const response = await relay(url, { method: 'POST', body: JSON.stringify(request) })
              return { service, cards: response?.cards || [] }
            } catch (error) {
              return { service: configured, cards: [], error: error.message }
            }
          }),
        )
      }),
    )
    return perEndpoint.flat()
  }

  // ------------------------------------------------------------------ styles --

  const STYLES = `
    .cdsh-page { padding: 1.5rem 2rem 4rem; max-width: 70rem; }
    .cdsh-page h1 { font-size: 1.75rem; font-weight: 400; margin-bottom: 0.5rem; }
    .cdsh-page h2 { font-size: 1.25rem; font-weight: 400; margin: 2rem 0 0.5rem; }
    .cdsh-page p, .cdsh-help { color: #525252; font-size: 0.875rem; line-height: 1.4; max-width: 50rem; }
    .cdsh-row { display: flex; gap: 0.5rem; align-items: flex-end; margin: 1rem 0; }
    .cdsh-row .cds--text-input-wrapper { flex: 1; max-width: 36rem; }
    .cdsh-endpoint { background: #fff; margin: 1rem 0; border: 1px solid #e0e0e0; }
    .cdsh-endpoint-header { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.5rem 0.5rem 1rem; border-bottom: 1px solid #e0e0e0; }
    .cdsh-endpoint-header code { flex: 1; font-size: 0.875rem; }
    .cdsh-service { display: flex; gap: 1rem; align-items: flex-start; padding: 0.75rem 1rem; border-bottom: 1px solid #e0e0e0; }
    .cdsh-service:last-child { border-bottom: 0; }
    .cdsh-service input[type=checkbox] { width: 1.125rem; height: 1.125rem; margin-top: 0.125rem; accent-color: #005d5d; }
    .cdsh-service-title { font-weight: 600; font-size: 0.875rem; }
    .cdsh-service-details { color: #525252; font-size: 0.75rem; margin-top: 0.25rem; }
    .cdsh-service-details code { font-size: 0.75rem; }
    .cdsh-tag { display: inline-block; background: #d9fbfb; color: #004144; border-radius: 1rem; padding: 0 0.5rem; font-size: 0.75rem; line-height: 1.5rem; white-space: nowrap; }
    .cdsh-tag-muted { background: #e0e0e0; color: #393939; }
    .cdsh-radio { display: flex; gap: 0.5rem; align-items: flex-start; margin: 0.5rem 0; font-size: 0.875rem; }
    .cdsh-radio input { margin-top: 0.125rem; accent-color: #005d5d; }
    .cdsh-status { font-size: 0.875rem; min-height: 1.25rem; margin-top: 1rem; }
    .cdsh-status-error { color: #da1e28; }
    .cdsh-status-ok { color: #198038; }
    .cdsh-admin-link { display: flex; flex-direction: column; box-sizing: border-box; width: 14rem; height: 8rem; padding: 1rem; background: #fff; text-decoration: none; color: #161616; }
    .cdsh-admin-link:hover { background: #e8e8e8; }
    .cdsh-admin-link-title { color: #525252; font-size: 0.875rem; margin: 1.5rem 0 0.5rem; }
    .cdsh-admin-link-action { font-size: 1rem; flex: 1; }
    .cdsh-admin-link-arrow { color: #0f62fe; text-align: right; line-height: 1; }

    .cdsh-cards { margin: 1rem 1.375rem 0; }
    .cdsh-cards-header { display: flex; align-items: center; gap: 0.75rem; font-size: 0.875rem; color: #525252; margin-bottom: 0.5rem; }
    .cdsh-cards-header strong { color: #161616; }
    .cdsh-cards-header button { background: none; border: 0; padding: 0; color: #0f62fe; cursor: pointer; font-size: 0.875rem; }
    .cdsh-card { background: #fff; border-left: 4px solid #0f62fe; padding: 0.75rem 1rem; margin-bottom: 0.5rem; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15); }
    .cdsh-card-warning { border-left-color: #f1c21b; }
    .cdsh-card-critical, .cdsh-card-error { border-left-color: #da1e28; }
    .cdsh-card-summary { font-weight: 600; font-size: 1rem; color: #161616; }
    .cdsh-card-detail { font-size: 0.875rem; color: #393939; margin-top: 0.25rem; white-space: pre-wrap; }
    .cdsh-card-footer { font-size: 0.75rem; color: #6f6f6f; margin-top: 0.5rem; display: flex; gap: 1rem; flex-wrap: wrap; }
    .cdsh-card-footer a { color: #0f62fe; }
  `

  function addStyles() {
    if (!document.getElementById('cdsh-styles')) document.head.append(h('style', { id: 'cdsh-styles' }, STYLES))
  }

  // -------------------------------------------------------------- admin page --

  function renderAdminPage(root) {
    const state = { uuid: undefined, config: structuredClone(DEFAULT_CONFIG) }
    const status = h('div', { class: 'cdsh-status', role: 'status' })
    const endpoints = h('div')
    const sharing = h('div')
    const urlInput = h('input', {
      class: 'cds--text-input',
      type: 'text',
      id: 'cdsh-discovery-url',
      placeholder: 'http://cds:8080/cds-services',
    })

    const report = (message, kind) => {
      status.textContent = message
      status.className = `cdsh-status ${kind ? `cdsh-status-${kind}` : ''}`
    }
    const save = async (message) => {
      try {
        await saveConfig(state)
        report(message || 'Saved', 'ok')
      } catch (error) {
        report(`Could not save: ${error.message}`, 'error')
      }
    }

    // Merges a fresh discovery into an endpoint, keeping which services were enabled.
    // Newly discovered services start disabled: the administrator decides what clinicians see.
    const applyDiscovery = (endpoint, services) => {
      const enabled = new Set(endpoint.services.filter((s) => s.enabled).map((s) => s.id))
      endpoint.services = services.map((s) => ({
        id: s.id,
        hook: s.hook,
        title: s.title,
        description: s.description,
        prefetch: s.prefetch,
        enabled: enabled.has(s.id) && SUPPORTED_HOOKS.includes(s.hook),
      }))
    }

    const addEndpoint = async () => {
      const url = urlInput.value.trim().replace(/\/$/, '')
      if (!/^https?:\/\/.+/.test(url)) return report('Enter the discovery URL of a CDS service, starting with http:// or https://', 'error')
      if (state.config.endpoints.some((e) => e.url === url)) return report('This CDS service is already registered', 'error')
      report('Contacting the CDS service ...')
      try {
        const endpoint = { url, services: [] }
        applyDiscovery(endpoint, await discover(url))
        state.config.endpoints.push(endpoint)
        urlInput.value = ''
        renderEndpoints()
        await save(`Registered ${url}: ${endpoint.services.length} service(s) found. Enable the ones clinicians should see.`)
      } catch (error) {
        report(`Could not discover services at ${url} (${error.message})`, 'error')
      }
    }

    const refreshEndpoint = async (endpoint) => {
      report('Contacting the CDS service ...')
      try {
        applyDiscovery(endpoint, await discover(endpoint.url))
        renderEndpoints()
        await save(`Refreshed ${endpoint.url}: ${endpoint.services.length} service(s) found`)
      } catch (error) {
        report(`Could not discover services at ${endpoint.url} (${error.message})`, 'error')
      }
    }

    function renderEndpoints() {
      endpoints.replaceChildren(
        ...state.config.endpoints.map((endpoint) =>
          h(
            'div',
            { class: 'cdsh-endpoint' },
            h(
              'div',
              { class: 'cdsh-endpoint-header' },
              h('code', {}, endpoint.url),
              h('button', { class: 'cds--btn cds--btn--sm cds--btn--ghost', onclick: () => refreshEndpoint(endpoint) }, 'Refresh'),
              h(
                'button',
                {
                  class: 'cds--btn cds--btn--sm cds--btn--danger--ghost',
                  onclick: () => {
                    state.config.endpoints = state.config.endpoints.filter((e) => e !== endpoint)
                    renderEndpoints()
                    save(`Removed ${endpoint.url}`)
                  },
                },
                'Remove',
              ),
            ),
            endpoint.services.length === 0 && h('div', { class: 'cdsh-service cdsh-help' }, 'This CDS service offers no services.'),
            endpoint.services.map((service) => {
              const supported = SUPPORTED_HOOKS.includes(service.hook)
              const id = `cdsh-service-${state.config.endpoints.indexOf(endpoint)}-${service.id}`
              return h(
                'div',
                { class: 'cdsh-service' },
                h('input', {
                  type: 'checkbox',
                  id,
                  checked: service.enabled,
                  disabled: !supported,
                  onchange: (event) => {
                    service.enabled = event.target.checked
                    save(`${service.title || service.id} is now ${service.enabled ? 'enabled' : 'disabled'}`)
                  },
                }),
                h(
                  'label',
                  { for: id, style: 'flex: 1' },
                  h('div', { class: 'cdsh-service-title' }, service.title || service.id),
                  h('div', { class: 'cdsh-help' }, service.description),
                  h(
                    'div',
                    { class: 'cdsh-service-details' },
                    'Service id ',
                    h('code', {}, service.id),
                    Object.keys(service.prefetch || {}).length > 0 &&
                      ` · asks for ${Object.values(service.prefetch)
                        .map((template) => template.split('?')[0].split('/')[0])
                        .filter((type, index, all) => all.indexOf(type) === index)
                        .join(', ')}`,
                  ),
                ),
                h(
                  'span',
                  { class: `cdsh-tag ${supported ? '' : 'cdsh-tag-muted'}` },
                  supported ? service.hook : `${service.hook} (not supported by this EHR)`,
                ),
              )
            }),
          ),
        ),
      )
    }

    function renderSharing() {
      const fhirInput = h('input', {
        class: 'cds--text-input',
        type: 'text',
        id: 'cdsh-fhir-server',
        value: state.config.fhirServer,
        onchange: (event) => {
          state.config.fhirServer = event.target.value.trim()
          save()
        },
      })
      const option = (value, title, help) =>
        h(
          'label',
          { class: 'cdsh-radio' },
          h('input', {
            type: 'radio',
            name: 'cdsh-prefetch',
            checked: state.config.sendPrefetch === value,
            onchange: () => {
              state.config.sendPrefetch = value
              save()
            },
          }),
          h('span', {}, h('strong', {}, title), h('br'), h('span', { class: 'cdsh-help' }, help)),
        )
      sharing.replaceChildren(
        option(
          true,
          'The EHR sends the data along (prefetch)',
          'When the hook fires, the EHR runs the queries a service asks for in its discovery document and includes the results in the call.',
        ),
        option(
          false,
          'The CDS service retrieves the data itself',
          'The EHR only sends the context (which patient, which user). The service queries the FHIR API below, using an access token that is limited to the user’s session.',
        ),
        h(
          'div',
          { class: 'cdsh-row' },
          h(
            'div',
            { class: 'cds--text-input-wrapper' },
            h('label', { class: 'cds--label', for: 'cdsh-fhir-server' }, 'FHIR API of this EHR, as reachable by CDS services'),
            fhirInput,
          ),
        ),
      )
    }

    root.replaceChildren(
      h(
        'div',
        { class: 'cdsh-page' },
        h('h1', {}, 'CDS Hooks'),
        h(
          'p',
          {},
          'Clinical decision support services that this EHR consults. Enabled services are called when a clinician opens a patient chart (the patient-view hook); the cards they return are shown at the top of the chart.',
        ),
        h('h2', {}, 'CDS services'),
        h(
          'div',
          { class: 'cdsh-row' },
          h(
            'div',
            { class: 'cds--text-input-wrapper' },
            h('label', { class: 'cds--label', for: 'cdsh-discovery-url' }, 'Discovery URL of the CDS service'),
            urlInput,
          ),
          h('button', { class: 'cds--btn cds--btn--md cds--btn--primary', onclick: addEndpoint }, 'Add'),
        ),
        endpoints,
        h('h2', {}, 'Patient data'),
        h('p', {}, 'CDS services work on FHIR data. This EHR does not store FHIR, but offers its data through a FHIR API.'),
        sharing,
        status,
      ),
    )
    urlInput.addEventListener('keydown', (event) => event.key === 'Enter' && addEndpoint())

    loadConfig()
      .then((loaded) => {
        Object.assign(state, loaded)
        renderEndpoints()
        renderSharing()
      })
      .catch((error) => report(`Could not load the configuration: ${error.message}`, 'error'))
  }

  function renderAdminCardLink(root) {
    root.replaceChildren(
      h(
        'a',
        { class: 'cdsh-admin-link', href: `${window.getOpenmrsSpaBase()}cds-hooks` },
        h('div', { class: 'cdsh-admin-link-title' }, 'Clinical decision support'),
        h('div', { class: 'cdsh-admin-link-action' }, 'CDS Hooks'),
        h('div', { class: 'cdsh-admin-link-arrow' }, '→'),
      ),
    )
  }

  // ----------------------------------------------------- cards in the chart --

  function renderCard(card, service) {
    const indicator = ['info', 'warning', 'critical'].includes(card.indicator) ? card.indicator : 'info'
    const links = (card.links || []).filter((link) => link.url && link.type !== 'smart')
    return h(
      'div',
      { class: `cdsh-card cdsh-card-${indicator}`, 'data-indicator': indicator },
      h('div', { class: 'cdsh-card-summary' }, card.summary),
      card.detail && h('div', { class: 'cdsh-card-detail' }, card.detail),
      h(
        'div',
        { class: 'cdsh-card-footer' },
        h(
          'span',
          {},
          'Source: ',
          card.source?.url
            ? h('a', { href: card.source.url, target: '_blank', rel: 'noopener' }, card.source.label || card.source.url)
            : card.source?.label || service.title || service.id,
        ),
        links.map((link) => h('a', { href: link.url, target: '_blank', rel: 'noopener' }, link.label || link.url)),
      ),
    )
  }

  function renderPatientViewCards(root, props) {
    const patientUuid = props.patientUuid || props.patient?.id
    if (!patientUuid) return
    const container = h('div', { class: 'cdsh-cards' })
    root.replaceChildren(container)

    const run = async () => {
      let config
      try {
        config = (await loadConfig()).config
      } catch {
        return container.replaceChildren() // this user may not read the configuration
      }
      const enabled = config.endpoints.flatMap((e) => e.services).filter((s) => s.enabled && s.hook === 'patient-view')
      if (enabled.length === 0) return container.replaceChildren()

      const header = (text) =>
        h('div', { class: 'cdsh-cards-header' }, h('strong', {}, 'Decision support'), h('span', {}, text))
      container.replaceChildren(header('Consulting decision support ...'))

      const results = await fireHook('patient-view', { patientId: patientUuid }, config).catch((error) => [
        { service: { title: 'CDS Hooks' }, cards: [], error: error.message },
      ])
      const cards = results.flatMap((result) => result.cards.map((card) => renderCard(card, result.service)))
      const errors = results
        .filter((result) => result.error)
        .map((result) =>
          h(
            'div',
            { class: 'cdsh-card cdsh-card-error' },
            h('div', { class: 'cdsh-card-summary' }, `${result.service.title || result.service.id} could not be consulted`),
            h('div', { class: 'cdsh-card-detail' }, result.error),
          ),
        )
      const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
      const summary = [
        cards.length > 0
          ? plural(cards.length, 'recommendation')
          : `No recommendations for this patient (${plural(results.length - errors.length, 'service')} consulted)`,
        errors.length > 0 && `${plural(errors.length, 'service')} could not be consulted`,
      ]
        .filter(Boolean)
        .join('; ')
      const top = header(summary)
      top.append(h('button', { onclick: run, title: 'Consult the decision support services again' }, 'Refresh'))
      container.replaceChildren(top, ...cards, ...errors)
    }
    run()
  }

  // ---------------------------------------------- OpenMRS app shell plumbing --

  // Turns a render(root, props) function into single-spa lifecycle functions.
  const lifecycle = (render) => () => {
    const rootOf = (props) => props.domElement || document.getElementById(`single-spa-application:${props.name}`)
    return {
      bootstrap: async () => {},
      mount: async (props) => {
        addStyles()
        render(rootOf(props), props)
      },
      unmount: async (props) => rootOf(props)?.replaceChildren(),
    }
  }

  const exports = {
    adminPage: lifecycle(renderAdminPage),
    adminCardLink: lifecycle(renderAdminCardLink),
    patientViewCards: lifecycle(renderPatientViewCards),
  }

  window[MODULE_NAME.replace(/[/\-@]/g, '_')] = {
    init: () => {},
    get: (name) => (name === './start' ? Promise.resolve(() => exports) : Promise.reject(new Error(`${MODULE_NAME} has no ${name}`))),
  }
})()
