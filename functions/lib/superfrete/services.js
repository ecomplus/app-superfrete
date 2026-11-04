// https://superfrete.readme.io/reference/cotacao-de-frete
// IDs de serviço aceitos pela API SuperFrete
const SERVICES = [
  { id: 1, label: 'PAC', aliases: ['pac'] },
  { id: 2, label: 'SEDEX', aliases: ['sedex'] },
  { id: 17, label: 'Mini Envios', aliases: ['mini envios', 'minienvios'] },
  { id: 3, label: 'Jadlog', aliases: ['jadlog', 'jadlog.package'] },
  { id: 31, label: 'Loggi', aliases: ['loggi', 'loggi econômico', 'loggi economico'] },
  { id: 33, label: 'J&T', aliases: ['j&t', 'j&t express', 'jet'] }
]

const ALL_SERVICE_IDS = SERVICES.map(({ id }) => id).join(',')
// padrão para lojas que não configuraram: apenas Correios
const DEFAULT_SERVICE_LABELS = ['PAC', 'SEDEX', 'Mini Envios']

// converte labels configurados no admin em IDs aceitos pela API (ex.: "1,2,17")
const getEnabledServiceIds = (labels) => {
  const enabled = Array.isArray(labels) && labels.length ? labels : DEFAULT_SERVICE_LABELS
  const ids = SERVICES
    .filter(({ label }) => enabled.includes(label))
    .map(({ id }) => id)
  return (ids.length ? ids : [1, 2, 17]).join(',')
}

const getServiceLabel = (id, fallbackName) => {
  const service = SERVICES.find(s => s.id === Number(id))
  return service ? service.label : fallbackName
}

// resolve o ID do serviço a partir do label/service_code salvo no shipping line
const getServiceId = (shippingLine) => {
  if (!shippingLine) return 1
  const customField = Array.isArray(shippingLine.custom_fields) &&
    shippingLine.custom_fields.find(({ field }) => field === 'superfrete_service_id')
  if (customField && Number(customField.value)) {
    return Number(customField.value)
  }
  const app = shippingLine.app || {}
  const candidates = [
    app.label,
    typeof app.service_code === 'string' ? app.service_code.replace(/^Superfrete_/i, '') : null
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const name = candidate.trim().toLowerCase()
      const service = SERVICES.find(s => s.aliases.includes(name))
      if (service) return service.id
    }
  }
  return 1
}

module.exports = {
  SERVICES,
  ALL_SERVICE_IDS,
  DEFAULT_SERVICE_LABELS,
  getEnabledServiceIds,
  getServiceLabel,
  getServiceId
}
