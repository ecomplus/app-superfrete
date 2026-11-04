// Testes offline da integração SuperFrete (mocks de SuperFrete, Firestore e E-Com Plus)
// Rodar com: npm test (dentro de functions/)
const path = require('path')
const Module = require('module')
const assert = require('assert')
const Ajv = require('ajv')
const addFormats = require('ajv-formats')

const FN = path.join(__dirname, '..')

// ---------- estado compartilhado dos mocks ----------
const state = {
  appData: {},
  sfCalls: [],
  sfHandlers: {},
  ecomCalls: [],
  ecomOrders: {},
  fsDocs: {},
  authDocs: []
}

// ---------- SuperFrete client fake ----------
class FakeSuperfrete {
  constructor (token, isSandbox) { this.token = token; this.isSandbox = isSandbox }
  async _call (method, url, data) {
    state.sfCalls.push({ method, url, data: data && JSON.parse(JSON.stringify(data)) })
    const key = Object.keys(state.sfHandlers).find(k => {
      const [m, re] = k.split(' ')
      return m === method && new RegExp(re).test(url)
    })
    if (!key) throw Object.assign(new Error(`no mock for ${method} ${url}`), { response: { status: 404, data: {} } })
    return state.sfHandlers[key](url, data)
  }

  get (url) { return this._call('get', url) }
  post (url, data) { return this._call('post', url, data) }
}

// ---------- Firestore fake ----------
const snap = (p) => ({
  exists: Boolean(state.fsDocs[p]),
  data: () => state.fsDocs[p] && { ...state.fsDocs[p] },
  get: (k) => state.fsDocs[p] && state.fsDocs[p][k],
  ref: { get: async () => snap(p) }
})
const firestore = {
  doc: (p) => ({
    get: async () => snap(p),
    set: async (d, opts) => { state.fsDocs[p] = opts && opts.merge ? { ...state.fsDocs[p], ...d } : d }
  }),
  collection: (name) => ({
    where: (field, op, val) => ({
      get: async () => {
        let docs
        if (name === 'ecomplus_app_auth') {
          docs = state.authDocs.map(d => ({ exists: true, get: k => d[k] }))
        } else {
          docs = Object.keys(state.fsDocs)
            .filter(p => p.startsWith(name + '/') && state.fsDocs[p][field] === val)
            .map(p => snap(p))
        }
        return { docs, forEach: fn => docs.forEach(fn) }
      }
    })
  })
}
const Timestamp = { now: () => 'TS_NOW', fromDate: d => d }

// ---------- E-Com Plus appSdk fake ----------
const appSdk = {
  getAuth: async () => ({ token: 'x' }),
  apiRequest: async (storeId, url, method, body) => {
    state.ecomCalls.push({ storeId, url, method, body: body && JSON.parse(JSON.stringify(body)) })
    if (method === 'GET' && url === '/stores/me.json') {
      return { response: { data: { name: 'Bijuteria', domain: 'loja.com', address: 'Rua da Loja, 10' } } }
    }
    const m = url.match(/^\/orders\/(\w+)\.json$/)
    if (method === 'GET' && m) return { response: { data: state.ecomOrders[m[1]] } }
    return { response: { data: {} } }
  }
}

// ---------- intercepta requires ----------
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (/__env$/.test(request)) return { isSandbox: true }
  if (request === 'firebase-admin/firestore') return { getFirestore: () => firestore, Timestamp }
  if (request === '@ecomplus/application-sdk') return { setup: async () => appSdk }
  if (/superfrete\/client$/.test(request)) return FakeSuperfrete
  if (/store-api\/get-app-data$/.test(request)) return async () => state.appData
  return origLoad.apply(this, arguments)
}

const calculate = require(path.join(FN, 'routes/ecom/modules/calculate-shipping.js'))
const webhook = require(path.join(FN, 'routes/ecom/webhook.js'))
const checkTracking = require(path.join(FN, 'lib/integration/check-tracking.js'))
const services = require(path.join(FN, 'lib/superfrete/services.js'))

// ---------- schema E-Com ----------
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
ajv.addMetaSchema(require('ajv/dist/refs/json-schema-draft-06.json'))
const validateResponse = ajv.compile(require('./fixtures/calculate-shipping-response.schema.json'))

// ---------- helpers ----------
const reset = () => {
  state.appData = { token: 'tok', zip: '01153-000' }
  state.sfCalls = []; state.sfHandlers = {}; state.ecomCalls = []; state.ecomOrders = {}; state.fsDocs = {}; state.authDocs = []
}
const fakeRes = () => {
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const res = { code: 200, status (c) { this.code = c; return this }, send (b) { this.body = b; resolveDone(this); return this } }
  return { res, done }
}
const quiet = async (fn) => {
  const l = console.log; const e = console.error; const logs = []
  console.log = (...a) => logs.push(['log', a]); console.error = (...a) => logs.push(['error', a])
  try { return await fn(logs) } finally { console.log = l; console.error = e }
}

// resposta de exemplo da doc (/calculator)
const quote = (id, name, price, extra = {}) => ({
  id,
  name,
  price,
  discount: '5.59',
  currency: 'R$',
  delivery_time: 5,
  delivery_range: { min: 4, max: 5 },
  packages: [{ price, discount: '5.59', format: 'box', dimensions: { height: '2', width: '11', length: '16' }, weight: '0.300', insurance_value: 0 }],
  additional_services: { receipt: false, own_hand: false },
  company: { id: 1, name: id === 3 ? 'Jadlog' : id === 31 ? 'Loggi' : id === 33 ? 'J&T Express' : 'Correios', picture: 'https://x/p.png' },
  has_error: false,
  ...extra
})
const calcHandler = () => (url, data) => {
  const ids = data.services.split(',').map(Number)
  const all = {
    1: quote(1, 'PAC', 22.5),
    2: quote(2, 'SEDEX', 35.1),
    17: { id: 17, name: 'Mini Envios', has_error: true, error: 'Peso excede o limite' },
    3: quote(3, 'JADLOG.PACKAGE', 19.9),
    31: quote(31, 'LOGGI Econômico', 18.2),
    33: quote(33, 'J&T', 17.0)
  }
  return { data: ids.map(i => all[i]).filter(Boolean) }
}
const calcParams = (extra = {}) => ({
  to: { zip: '30140-071', name: 'Ana', street: 'Rua X', number: 10 },
  subtotal: 150,
  items: [
    { product_id: 'p1', sku: 'S1', name: 'Anel', quantity: 2, price: 50, final_price: 50, weight: { value: 150, unit: 'g' }, dimensions: { width: { value: 10, unit: 'cm' }, height: { value: 2, unit: 'cm' }, length: { value: 15, unit: 'cm' } } },
    { product_id: 'p2', sku: 'S2', name: 'Colar', quantity: 1, price: 50, weight: { value: 0.1, unit: 'kg' } }
  ],
  ...extra
})
const runCalc = async (params) => {
  const { res, done } = fakeRes()
  await quiet(() => calculate.post({ appSdk }, { body: { params, application: { data: state.appData, hidden_data: {} } } }, res))
  return done
}

const results = []
const test = async (name, fn) => {
  reset()
  try { await fn(); results.push(['PASS', name]) } catch (e) { results.push(['FAIL', name, e.message]) }
}

;(async () => {
  // ================= COTAÇÃO =================
  await test('cotação: sem configuração envia só Correios (1,2,17)', async () => {
    state.sfHandlers['post ^/calculator$'] = calcHandler()
    const r = await runCalc(calcParams())
    assert.strictEqual(r.code, 200)
    assert.strictEqual(state.sfCalls[0].data.services, '1,2,17')
  })

  await test('cotação: resposta válida no schema da E-Com Plus', async () => {
    state.sfHandlers['post ^/calculator$'] = calcHandler()
    state.appData.services = ['PAC', 'SEDEX', 'Mini Envios', 'Jadlog', 'Loggi', 'J&T']
    const r = await runCalc(calcParams())
    const ok = validateResponse(r.body)
    assert.ok(ok, JSON.stringify(validateResponse.errors, null, 1))
  })

  await test('cotação: serviço com has_error é descartado', async () => {
    state.sfHandlers['post ^/calculator$'] = calcHandler()
    const r = await runCalc(calcParams())
    const labels = r.body.shipping_services.map(s => s.label)
    assert.deepStrictEqual(labels, ['PAC', 'SEDEX'])
  })

  await test('cotação: transportadoras novas só quando ativadas, com label e ID corretos', async () => {
    state.sfHandlers['post ^/calculator$'] = calcHandler()
    state.appData.services = ['PAC', 'Jadlog', 'Loggi', 'J&T']
    const r = await runCalc(calcParams())
    assert.strictEqual(state.sfCalls[0].data.services, '1,3,31,33')
    const map = Object.fromEntries(r.body.shipping_services.map(s => [s.label, s]))
    assert.deepStrictEqual(Object.keys(map), ['PAC', 'Jadlog', 'Loggi', 'J&T'])
    assert.strictEqual(map.Jadlog.service_code, 'Superfrete_Jadlog')
    assert.deepStrictEqual(map['J&T'].shipping_line.custom_fields, [{ field: 'superfrete_service_id', value: '33' }])
    assert.strictEqual(map.Loggi.carrier, 'Loggi')
  })

  await test('cotação: desabilitar serviço por label novo (Loggi)', async () => {
    state.sfHandlers['post ^/calculator$'] = calcHandler()
    state.appData.services = ['PAC', 'Loggi']
    state.appData.disable_services = [{ service: 'Loggi' }]
    const r = await runCalc(calcParams())
    assert.deepStrictEqual(r.body.shipping_services.map(s => s.label), ['PAC'])
  })

  await test('cotação: regra antiga por nome (SEDEX frete grátis) continua funcionando', async () => {
    state.sfHandlers['post ^/calculator$'] = calcHandler()
    state.appData.shipping_rules = [{ service: 'SEDEX', min_amount: 1, free_shipping: true }]
    const r = await runCalc(calcParams())
    const sedex = r.body.shipping_services.find(s => s.label === 'SEDEX')
    assert.strictEqual(sedex.shipping_line.total_price, 0)
    assert.strictEqual(sedex.service_code, 'Superfrete_SEDEX')
  })

  await test('cotação: erro 400 da API vira 409 sem crash', async () => {
    state.sfHandlers['post ^/calculator$'] = () => { throw Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { message: 'CEP inválido' } } }) }
    const r = await runCalc(calcParams())
    assert.strictEqual(r.code, 409)
    assert.strictEqual(r.body.message, 'CEP inválido')
  })

  await test('cotação: sem destino retorna só preview de frete grátis', async () => {
    state.appData.free_shipping_from_value = 200
    const r = await runCalc({ items: [] })
    assert.deepStrictEqual(r.body, { shipping_services: [], free_shipping_from_value: 200 })
    assert.strictEqual(state.sfCalls.length, 0)
  })

  await test('cotação: products com peso em kg e dimensões em cm', async () => {
    state.sfHandlers['post ^/calculator$'] = calcHandler()
    await runCalc(calcParams())
    const { products } = state.sfCalls[0].data
    assert.strictEqual(products[0].weight, 0.15)
    assert.strictEqual(products[0].width, 10)
    assert.strictEqual(products[1].weight, 0.1)
  })

  // ================= WEBHOOK (criação de etiqueta) =================
  const baseOrder = (shippingLine, extra = {}) => ({
    _id: 'ord1',
    number: 1001,
    status: 'open',
    fulfillment_status: { current: 'ready_for_shipping' },
    buyers: [{ _id: 'b1', display_name: 'Ana Souza', main_email: 'ana@ex.com', doc_number: '123.456.789-09', phones: [{ country_code: 55, number: '(31) 99876-5432' }] }],
    items: [{ sku: 'S1', name: 'Anel', quantity: 2, price: 50, final_price: 45 }],
    shipping_lines: [{
      _id: 'sl1',
      app: { service_name: 'Superfrete', label: 'PAC', service_code: 'Superfrete_PAC' },
      from: { zip: '01153-000', street: 'Rua Origem', number: 100, borough: 'Barra Funda', city: 'São Paulo', province_code: 'SP' },
      to: { zip: '30140-071', name: 'Ana Souza', street: 'Avenida Afonso Pena com nome muito comprido para testar corte', number: 'S/N', complement: 'Apartamento 1203 bloco B torre 2', city: 'Belo Horizonte', province_code: 'mg' },
      declared_value: 90,
      own_hand: false,
      receipt: false,
      package: { dimensions: { width: { value: 11 }, height: { value: 2 }, length: { value: 16 } }, weight: { value: 0.3 } },
      ...shippingLine
    }],
    ...extra
  })
  const runWebhook = async (order) => {
    state.ecomOrders[order._id] = order
    state.sfHandlers['post ^/cart$'] = () => ({ data: { id: 'SF123', price: 20, status: 'pending' } })
    state.sfHandlers['get ^/order/info/SF123$'] = () => ({ data: { id: 'SF123', status: 'pending', tracking: null } })
    state.sfHandlers['post ^/order/cancel$'] = () => ({ data: { SF123: { canceled: true } } })
    const { res, done } = fakeRes()
    await quiet(async () => {
      webhook.post({ appSdk }, { storeId: 1011, body: { resource: 'orders', resource_id: order._id } }, res)
      await done
    })
    return done
  }

  await test('webhook: J&T (pedido novo) gera /cart conforme a doc', async () => {
    state.appData.status_send_order = 'Pronto Para Envio'
    const r = await runWebhook(baseOrder({
      app: { service_name: 'Superfrete', label: 'J&T', service_code: 'Superfrete_J&T' },
      custom_fields: [{ field: 'superfrete_service_id', value: '33' }]
    }))
    assert.strictEqual(r.body, 'SUCCESS')
    const cart = state.sfCalls.find(c => c.url === '/cart').data
    assert.strictEqual(cart.service, 33)
    assert.strictEqual(cart.to.phone, '31998765432')
    assert.strictEqual(cart.to.phone.length, 11)
    assert.strictEqual(cart.to.document, '12345678909')
    assert.strictEqual(cart.to.email, 'ana@ex.com')
    assert.strictEqual(cart.to.district, 'NA')
    assert.strictEqual(cart.to.state_abbr, 'MG')
    assert.strictEqual(cart.to.postal_code, '30140071')
    assert.ok(cart.to.address.length <= 50)
    assert.ok(cart.to.complement.length <= 20)
    assert.strictEqual(cart.from.name, 'Loja Bijuteria')
    assert.strictEqual(cart.from.number, '100')
    assert.strictEqual(cart.options.non_commercial, true)
    assert.strictEqual(cart.options.insurance_value, 90)
    assert.deepStrictEqual(cart.volumes, { width: 11, height: 2, length: 16, weight: 0.3 })
    assert.strictEqual(cart.platform, 'e-com.plus')
    assert.deepStrictEqual(cart.options.tags, [{ tag: 'ord1' }])
    assert.strictEqual(state.fsDocs['shippings/1011_ord1'].id, 'SF123')
  })

  await test('webhook: pedido antigo (sem custom_fields) com SEDEX e NF-e', async () => {
    state.appData.status_send_order = 'Pronto Para Envio'
    await runWebhook(baseOrder({
      app: { service_name: 'Superfrete', label: 'SEDEX', service_code: 'Superfrete_SEDEX' },
      invoices: [{ number: 4567, access_key: '3'.repeat(44) }]
    }))
    const cart = state.sfCalls.find(c => c.url === '/cart').data
    assert.strictEqual(cart.service, 2)
    assert.strictEqual(cart.options.non_commercial, false)
    assert.deepStrictEqual(cart.options.invoice, { number: '4567', key: '3'.repeat(44) })
  })

  await test('webhook: Mini Envios por label (bug antigo do toLowerCase)', async () => {
    state.appData.status_send_order = 'Pronto Para Envio'
    await runWebhook(baseOrder({ app: { service_name: 'Superfrete', label: 'Mini Envios', service_code: 'Superfrete_Mini Envios' } }))
    assert.strictEqual(state.sfCalls.find(c => c.url === '/cart').data.service, 17)
  })

  await test('webhook: status diferente do configurado não cria etiqueta', async () => {
    state.appData.status_send_order = 'NF Emitida'
    const r = await runWebhook(baseOrder({}))
    assert.strictEqual(r.body, 'SKIP')
    assert.ok(!state.sfCalls.some(c => c.url === '/cart'))
  })

  await test('webhook: frete de outro app é ignorado', async () => {
    state.appData.status_send_order = 'Pronto Para Envio'
    const r = await runWebhook(baseOrder({ app: { service_name: 'Correios', label: 'PAC' } }))
    assert.strictEqual(r.body, 'SKIP')
    assert.strictEqual(state.sfCalls.length, 0)
  })

  await test('webhook: pedido cancelado cancela na SuperFrete (order objeto, não array)', async () => {
    state.fsDocs['shippings/1011_ord1'] = { id: 'SF123', storeId: 1011, orderId: 'ord1', status: 'pending' }
    const r = await runWebhook(baseOrder({}, { status: 'cancelled', cancel_reason: 'cliente desistiu' }))
    assert.strictEqual(r.body, 'SUCCESS')
    const c = state.sfCalls.find(c => c.url === '/order/cancel').data
    assert.strictEqual(c.order.id, 'SF123')
    assert.ok(typeof c.order.description === 'string')
    assert.strictEqual(state.fsDocs['shippings/1011_ord1'].status, 'canceled')
  })

  await test('webhook: pedido já com etiqueta não duplica', async () => {
    state.appData.status_send_order = 'Pronto Para Envio'
    state.fsDocs['shippings/1011_ord1'] = { id: 'SF123', storeId: 1011, orderId: 'ord1', status: 'pending' }
    const r = await runWebhook(baseOrder({}))
    assert.strictEqual(r.body, 'SKIP')
    assert.ok(!state.sfCalls.some(c => c.url === '/cart'))
  })

  await test('webhook: sem nome/telefone no endereço usa dados do comprador', async () => {
    state.appData.status_send_order = 'Pronto Para Envio'
    const o = baseOrder({})
    delete o.shipping_lines[0].to.name
    await runWebhook(o)
    const cart = state.sfCalls.find(c => c.url === '/cart').data
    assert.strictEqual(cart.to.name, 'Ana Souza')
    assert.strictEqual(cart.to.phone, '31998765432')
  })

  // ================= CRON DE RASTREIO =================
  const runCron = async () => {
    state.authDocs = [{ store_id: 1011 }]
    let logs
    await quiet(async (l) => { logs = l; await checkTracking() })
    return logs
  }
  const orderForCron = (id, tracking = []) => {
    state.ecomOrders[id] = { _id: id, shipping_lines: [{ _id: 'sl1', tracking_codes: tracking }], fulfillment_status: { current: 'in_separation' } }
  }

  await test('cron: pending → checkout → released grava rastreio e status', async () => {
    orderForCron('ord1')
    state.fsDocs['shippings/1011_ord1'] = { id: 'SF1', storeId: 1011, orderId: 'ord1', status: 'pending' }
    let paid = false
    state.sfHandlers['get ^/order/info/SF1$'] = () => ({ data: paid ? { id: 'SF1', status: 'released', tracking: 'BR123' } : { id: 'SF1', status: 'pending', tracking: null } })
    state.sfHandlers['post ^/checkout$'] = (u, d) => { paid = true; return { data: { success: true } } }
    await runCron()
    assert.deepStrictEqual(state.sfCalls.find(c => c.url === '/checkout').data, { orders: ['SF1'] })
    const patch = state.ecomCalls.find(c => c.method === 'PATCH')
    assert.deepStrictEqual(patch.body, { tracking_codes: [{ code: 'BR123' }] })
    const ful = state.ecomCalls.find(c => c.url.endsWith('/fulfillments.json'))
    assert.strictEqual(ful.body.status, 'ready_for_shipping')
    assert.strictEqual(state.fsDocs['shippings/1011_ord1'].status, 'released')
  })

  await test('cron: rastreio aparece num ciclo posterior (released) e é gravado', async () => {
    orderForCron('ord1')
    state.fsDocs['shippings/1011_ord1'] = { id: 'SF1', storeId: 1011, orderId: 'ord1', status: 'released' }
    state.sfHandlers['get ^/order/info/SF1$'] = () => ({ data: { id: 'SF1', status: 'posted', tracking: 'BR999' } })
    await runCron()
    assert.ok(state.ecomCalls.some(c => c.method === 'PATCH' && c.body.tracking_codes[0].code === 'BR999'))
    assert.strictEqual(state.ecomCalls.find(c => c.url.endsWith('/fulfillments.json')).body.status, 'shipped')
  })

  await test('cron: rastreio já existente não duplica', async () => {
    orderForCron('ord1', [{ code: 'BR999' }])
    state.fsDocs['shippings/1011_ord1'] = { id: 'SF1', storeId: 1011, orderId: 'ord1', status: 'posted' }
    state.sfHandlers['get ^/order/info/SF1$'] = () => ({ data: { id: 'SF1', status: 'posted', tracking: 'BR999' } })
    await runCron()
    assert.ok(!state.ecomCalls.some(c => c.method === 'PATCH'))
  })

  await test('cron: falha em um pedido não impede os outros', async () => {
    orderForCron('ord1'); orderForCron('ord2')
    state.fsDocs['shippings/1011_ord1'] = { id: 'SF1', storeId: 1011, orderId: 'ord1', status: 'released' }
    state.fsDocs['shippings/1011_ord2'] = { id: 'SF2', storeId: 1011, orderId: 'ord2', status: 'released' }
    state.sfHandlers['get ^/order/info/SF1$'] = () => { throw Object.assign(new Error('500'), { response: { data: { message: 'internal' } } }) }
    state.sfHandlers['get ^/order/info/SF2$'] = () => ({ data: { id: 'SF2', status: 'posted', tracking: 'BR2' } })
    const logs = await runCron()
    assert.ok(state.ecomCalls.some(c => c.url === '/orders/ord2/shipping_lines/sl1.json'))
    assert.ok(logs.some(([t, a]) => t === 'error' && String(a[0]).includes('SF1')))
  })

  await test('cron: checkout sem saldo é logado e não quebra', async () => {
    orderForCron('ord1')
    state.fsDocs['shippings/1011_ord1'] = { id: 'SF1', storeId: 1011, orderId: 'ord1', status: 'pending' }
    state.sfHandlers['get ^/order/info/SF1$'] = () => ({ data: { id: 'SF1', status: 'pending', tracking: null } })
    state.sfHandlers['post ^/checkout$'] = () => { throw Object.assign(new Error('400'), { response: { data: { message: 'Saldo insuficiente' } } }) }
    const logs = await runCron()
    assert.ok(logs.some(([t, a]) => t === 'error' && String(a[0]).includes('checkout')))
    assert.ok(!state.ecomCalls.some(c => c.method === 'PATCH'))
  })

  await test('cron: etiquetas canceladas (as duas grafias) são ignoradas', async () => {
    state.fsDocs['shippings/1011_a'] = { id: 'A', storeId: 1011, orderId: 'a', status: 'canceled' }
    state.fsDocs['shippings/1011_b'] = { id: 'B', storeId: 1011, orderId: 'b', status: 'cancelled' }
    await runCron()
    assert.strictEqual(state.sfCalls.length, 0)
  })

  // ================= casos encontrados no sandbox =================
  await test('cotação: produto sem peso/dimensões recebe mínimos (API rejeitava a cotação inteira)', async () => {
    state.sfHandlers['post ^/calculator$'] = calcHandler()
    const p = calcParams()
    delete p.items[0].weight
    await runCalc(p)
    const { products } = state.sfCalls[0].data
    products.forEach(pr => ['weight', 'height', 'width', 'length'].forEach(k => assert.ok(pr[k] > 0, `${k} ausente`)))
    assert.strictEqual(products[0].weight, 0.1)
    assert.strictEqual(products[1].height, 1)
  })

  await test('cotação: caixa única (use_bigger_box) sem dimensões recebe mínimos', async () => {
    state.sfHandlers['post ^/calculator$'] = calcHandler()
    state.appData.use_bigger_box = true
    await runCalc(calcParams({ items: [{ sku: 'X', quantity: 1, price: 10 }] }))
    assert.deepStrictEqual(state.sfCalls[0].data.package, { weight: 0.1, height: 1, width: 1, length: 1 })
  })

  await test('webhook: timeout no /cart recupera etiqueta criada pela tag (sem duplicar)', async () => {
    state.appData.status_send_order = 'Pronto Para Envio'
    const order = baseOrder({})
    state.ecomOrders[order._id] = order
    let listCalls = 0
    state.sfHandlers['post ^/cart$'] = () => { throw Object.assign(new Error('timeout of 25000ms exceeded'), { code: 'ECONNABORTED' }) }
    state.sfHandlers['get ^/me/orders'] = () => {
      listCalls++
      // 1ª listagem ainda sem a etiqueta (atraso de indexação)
      const data = listCalls === 1
        ? []
        : [
            { order_id: 'OUTRA', created_at: new Date().toISOString(), to: { postal_code: '30140071' } },
            { order_id: 'SFX', created_at: new Date().toISOString(), to: { postal_code: '30140071' } }
          ]
      return { data: { data, meta: {} } }
    }
    state.sfHandlers['get ^/order/info/OUTRA$'] = () => ({ data: { id: 'OUTRA', status: 'pending', tags: [{ tag: 'outro-pedido' }] } })
    state.sfHandlers['get ^/order/info/SFX$'] = () => ({ data: { id: 'SFX', status: 'pending', tags: [{ tag: 'ord1' }] } })
    const { res, done } = fakeRes()
    await quiet(async () => {
      webhook.post({ appSdk }, { storeId: 1011, body: { resource: 'orders', resource_id: 'ord1' } }, res)
      await done
    })
    const r = await done
    assert.strictEqual(r.body, 'SUCCESS')
    assert.strictEqual(state.fsDocs['shippings/1011_ord1'].id, 'SFX')
    assert.strictEqual(state.sfCalls.filter(c => c.url === '/cart').length, 1)
  })

  await test('webhook: erro de validação do /cart (com resposta) não tenta recuperar', async () => {
    state.appData.status_send_order = 'Pronto Para Envio'
    const order = baseOrder({})
    state.ecomOrders[order._id] = order
    state.sfHandlers['post ^/cart$'] = () => { throw Object.assign(new Error('400'), { response: { status: 400, data: { message: 'erro' } } }) }
    const { res, done } = fakeRes()
    await quiet(async () => { webhook.post({ appSdk }, { storeId: 1011, body: { resource: 'orders', resource_id: 'ord1' } }, res); await done })
    const r = await done
    assert.strictEqual(r.code, 500)
    assert.ok(!state.sfCalls.some(c => c.url.startsWith('/me/orders')))
    assert.ok(!state.fsDocs['shippings/1011_ord1'])
  })

  await test('cron: etiqueta pending não regride pedido "Pronto para envio"', async () => {
    state.ecomOrders.ord1 = { _id: 'ord1', shipping_lines: [{ _id: 'sl1', tracking_codes: [] }], fulfillment_status: { current: 'ready_for_shipping' } }
    state.fsDocs['shippings/1011_ord1'] = { id: 'SF1', storeId: 1011, orderId: 'ord1', status: 'pending' }
    state.sfHandlers['get ^/order/info/SF1$'] = () => ({ data: { id: 'SF1', status: 'pending', tracking: null } })
    state.sfHandlers['post ^/checkout$'] = () => { throw Object.assign(new Error('400'), { response: { data: { message: 'Sem saldo' } } }) }
    await runCron()
    assert.ok(!state.ecomCalls.some(c => c.url.endsWith('/fulfillments.json')))
  })

  await test('cron: delivered avança pedido shipped → delivered', async () => {
    state.ecomOrders.ord1 = { _id: 'ord1', shipping_lines: [{ _id: 'sl1', tracking_codes: [{ code: 'BR1' }] }], fulfillment_status: { current: 'shipped' } }
    state.fsDocs['shippings/1011_ord1'] = { id: 'SF1', storeId: 1011, orderId: 'ord1', status: 'posted' }
    state.sfHandlers['get ^/order/info/SF1$'] = () => ({ data: { id: 'SF1', status: 'delivered', tracking: 'BR1' } })
    await runCron()
    assert.strictEqual(state.ecomCalls.find(c => c.url.endsWith('/fulfillments.json')).body.status, 'delivered')
  })

  // ================= services.js =================
  await test('services: getEnabledServiceIds / getServiceId', async () => {
    assert.strictEqual(services.getEnabledServiceIds(undefined), '1,2,17')
    assert.strictEqual(services.getEnabledServiceIds(['J&T', 'PAC']), '1,33')
    assert.strictEqual(services.getServiceId({ app: { label: 'LOGGI Econômico' } }), 31)
    assert.strictEqual(services.getServiceId({ app: { service_code: 'Superfrete_JADLOG.PACKAGE' } }), 3)
  })

  Module._load = origLoad
  // ================= client real (headers) =================
  await test('client real: headers Authorization e User-Agent', async () => {
    const Real = require(path.join(FN, 'lib/superfrete/client.js'))
    const c = new Real('tok', true)
    assert.strictEqual(c._baseURL, 'https://sandbox.superfrete.com/api/v0')
    const h = c._request.defaults.headers
    assert.strictEqual(h.Authorization, 'Bearer tok')
    assert.strictEqual(h['User-Agent'], 'E-Com Plus App Superfrete/1.0 (ti@e-com.club)')
  })

  for (const [s, n, e] of results) console.log(`${s === 'PASS' ? '✔' : '✘'} ${n}${e ? '\n    → ' + e : ''}`)
  const failed = results.filter(r => r[0] === 'FAIL').length
  console.log(`\n${results.length - failed}/${results.length} passaram`)
  process.exit(failed ? 1 : 0)
})()
