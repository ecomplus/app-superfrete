const getAppData = require('./../../lib/store-api/get-app-data')
const Superfrete = require('./../../lib/superfrete/client')
const { isSandbox } = require('../../__env')
const { getServiceId } = require('./../../lib/superfrete/services')
const { Timestamp, getFirestore } = require('firebase-admin/firestore')

const SKIP_TRIGGER_NAME = 'SkipTrigger'
const ECHO_SUCCESS = 'SUCCESS'
const ECHO_SKIP = 'SKIP'
const ECHO_API_ERROR = 'STORE_API_ERR'

const getDocInFirestore = (documentId) => new Promise((resolve, reject) => {
  getFirestore().doc(documentId).get()
    .then((doc) => {
      if (doc.exists) {
        resolve(doc)
      } else {
        resolve(null)
      }
    })
    .catch(reject)
})

const cut = (str, max) => (str ? String(str).trim().substring(0, max) : '')
const onlyDigits = (str) => (str ? String(str).replace(/\D/g, '') : '')

// https://superfrete.readme.io/reference/adicionar-frete-carrinho
const parseAddress = (address = {}, store, isSender) => {
  let name = address.name
  if (!name) {
    name = store?.name || '-'
  }
  name = String(name).trim()
  if (isSender && !/\s/.test(name)) {
    // remetente deve ter nome completo (ao menos duas palavras)
    name = `Loja ${name}`
  }

  const body = {
    name: cut(name, 50),
    address: cut(address.street || (typeof store?.address === 'string' ? store.address : ''), 50),
    number: cut(address.number, 10),
    district: cut(address.borough, 50) || 'NA',
    city: cut(address.city, 50) || 'Cidade',
    state_abbr: (address.province_code || 'MG').toUpperCase(),
    postal_code: onlyDigits(address.zip).padStart(8, '0')
  }

  if (address.complement) {
    body.complement = cut(address.complement, 20)
  }

  return body
}

const parsePhone = (phone) => {
  let number = onlyDigits(phone?.number || phone)
  if (number.length > 11 && number.startsWith('55')) {
    number = number.substring(2)
  }
  return number.length >= 10 ? number : null
}

// procura etiqueta pendente recente com a tag do pedido
// (a listagem da SuperFrete leva alguns segundos para incluir etiquetas novas)
const findLabelByTag = async (superfreteApi, tag, postalCode, attempts = 3, delayMs = 4000) => {
  const checked = new Set()
  // normaliza o CEP para comparar só dígitos (a listagem pode devolver com traço)
  const zip = onlyDigits(postalCode)
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise(resolve => setTimeout(resolve, delayMs))
    try {
      const { data } = await superfreteApi
        .get('/me/orders?status=pending&per_page=20&order=desc&sort_by=created_at')
      const minDate = Date.now() - 15 * 60 * 1000
      const candidates = (data?.data || []).filter(item => {
        return item.order_id && !checked.has(item.order_id) &&
          (!zip || onlyDigits(item.to?.postal_code) === zip) &&
          new Date(item.created_at).getTime() > minDate
      })
      for (const item of candidates) {
        checked.add(item.order_id)
        const { data: info } = await superfreteApi.get(`/order/info/${item.order_id}`)
        if (Array.isArray(info?.tags) && info.tags.some(t => t.tag === tag)) {
          return info
        }
      }
    } catch (err) {
      console.error('>> Failed to search Superfrete labels', err.response?.data || err.message)
    }
  }
  return null
}

exports.post = ({ appSdk }, req, res) => {
  // receiving notification from Store API
  const { storeId } = req

  /**
   * Treat E-Com Plus trigger body here
   * Ref.: https://developers.e-com.plus/docs/api/#/store/triggers/
   */
  const trigger = req.body
  let auth
  let appData
  const orderId = trigger.resource_id
  console.log('>> ', storeId, ' ', orderId)
  appSdk.getAuth(storeId)
    .then(async (_auth) => {
      auth = _auth
      return getAppData({ appSdk, storeId, auth })
    })
    .then((_appData) => {
      appData = _appData

      if (
        Array.isArray(appData.ignore_triggers) &&
        appData.ignore_triggers.indexOf(trigger.resource) > -1
      ) {
        // ignore current trigger
        const err = new Error()
        err.name = SKIP_TRIGGER_NAME
        throw err
      }

      if (trigger.resource !== 'orders') {
        const err = new Error()
        err.name = ECHO_SKIP
        throw err
      }
      return appSdk.apiRequest(storeId, `/orders/${orderId}.json`, 'GET', null, auth)
        .then(({ response }) => {
          return response.data
        })
    })
    .then(async (order) => {
      if (order && !order.shipping_lines.length) {
        const err = new Error()
        err.name = ECHO_SKIP
        throw err
      } else if (order && order.shipping_lines[0] && order.shipping_lines[0].app && order.shipping_lines[0].app.service_name !== 'Superfrete') {
        // const err = new Error()
        // err.name = ECHO_SKIP
        // throw err
        return res.send(ECHO_SKIP)
      }

      const {
        status,
        fulfillment_status: fulfillmentStatus,
        shipping_lines: shippingLines,
        items,
        buyers
      } = order

      const docId = `shippings/${storeId}_${orderId}`
      const doc = await getDocInFirestore(docId)
      const buyer = buyers && buyers[0]
      // criação de etiqueta pode passar de 10s (function tem limite de 60s)
      const superfreteApi = new Superfrete(appData.token, isSandbox, { timeout: 25000 })
      console.log('>> OrderFirestore: ', JSON.stringify(doc))

      const shippingLine = shippingLines && shippingLines[0]

      const isInSeparation = fulfillmentStatus && fulfillmentStatus.current === 'in_separation'
      const shippingStatus = fulfillmentStatus && fulfillmentStatus.current
      const parseShippingStatus = (_statusShipping) => {
        switch (_statusShipping) {
          case 'invoice_issued':
            return 'NF Emitida'
          case 'in_production':
            return 'Em produção'
          case 'in_separation':
            return 'Em Separação'
          case 'ready_for_shipping':
            return 'Pronto Para Envio'
          default:
            return _statusShipping
        }
      }

      if (doc && status === 'cancelled' && !['shipped', 'delivered'].includes(shippingStatus)) {
        console.log('> Try Cancell in Superfrete')
        const docSnapshot = await getFirestore().doc(docId)
          .get()
        const doc = docSnapshot.data()
        const appMsg = order.cancel_reason || ''
        await superfreteApi.post('/order/cancel', {
          order: {
            id: doc.id,
            description: `Cancelado pelo app ${appMsg}`
          }
        }).then(async () => {
          return getFirestore().doc(docId)
            .set({
              status: 'canceled',
              cancelledAt: Timestamp.now(),
              appMsg
            }, { merge: true })
            .catch(console.error)
        })

        return res.send(ECHO_SUCCESS)
      } else if (!doc && shippingStatus && status !== 'cancelled') {
        // create in superfrete and insert in firebase
        if ((appData.enable_tag && isInSeparation) || appData.status_send_order === parseShippingStatus(shippingStatus)) {
          const store = await appSdk.apiRequest(storeId, '/stores/me.json', 'GET', null, auth)
            .then(({ response }) => {
              const _store = {}
              const fields = Object.keys(response.data)
              fields.forEach(field => {
                switch (field) {
                  case 'name':
                  case 'address':
                  case 'domain':
                    _store[field] = response.data[field]
                    break
                  default:
                    break
                }
              })
              return _store
            })
          // console.log('>> Store: ', JSON.stringify(store))

          // console.log('>> ', JSON.stringify(shippingLine.package))
          let volumes
          if (shippingLine.package) {
            const pkg = shippingLine.package
            volumes = {
              width: pkg.dimensions.width.value,
              height: pkg.dimensions.height.value,
              length: pkg.dimensions.length.value,
              weight: pkg.weight.value
            }
          }

          const products = items?.map((item) => {
            return {
              name: item.name || item.sku,
              quantity: item.quantity,
              unitary_value: item.final_price || item.price
            }
          })

          const from = parseAddress(shippingLine.from, store, true)
          const to = parseAddress(shippingLine.to)
          if (!shippingLine.to?.name && buyer) {
            to.name = cut(buyer.display_name || buyer.name?.given_name || to.name, 50)
          }
          // documento do destinatário é necessário para DC-e
          if (buyer?.doc_number) {
            to.document = onlyDigits(buyer.doc_number)
          }
          if (buyer?.main_email) {
            to.email = buyer.main_email
          }
          // telefone obrigatório para J&T (11 dígitos, sem formatação)
          const phone = parsePhone(shippingLine.to?.phone) ||
            parsePhone(buyer?.phones && buyer.phones[0])
          if (phone) {
            to.phone = phone
          }
          const invoice = shippingLine.invoices && shippingLine.invoices[0]

          const body = {
            from,
            to,
            service: getServiceId(shippingLine),
            volumes,
            products,
            options: {
              own_hand: Boolean(shippingLine.own_hand),
              receipt: Boolean(shippingLine.receipt),
              // sem NF-e: envio com declaração de conteúdo
              non_commercial: !invoice,
              tags: [
                {
                  tag: orderId
                }
              ]
            },
            platform: 'e-com.plus'
          }

          if (shippingLine.declared_value) {
            body.options.insurance_value = shippingLine.declared_value
          }

          if (invoice) {
            const { number, access_key: key } = invoice
            body.options.invoice = { number: String(number || ''), key }
          }

          console.log('>> Try ', JSON.stringify(body))
          const label = await superfreteApi.post('/cart', body)
            .then(({ data }) => data)
            .catch(async (err) => {
              if (err.response) {
                console.error('>> Superfrete cart error', JSON.stringify(err.response.data))
                throw err
              }
              // timeout/rede: a etiqueta pode ter sido criada mesmo sem resposta,
              // procura antes de falhar para não duplicar no próximo disparo
              console.error('>> Superfrete cart without response', err.message)
              const found = await findLabelByTag(superfreteApi, orderId, to.postal_code)
              if (found) {
                console.log('>> Recovered label', found.id)
                return found
              }
              throw err
            })
          const data = await superfreteApi.get(`/order/info/${label.id}`)
            .then(({ data }) => data)
            .catch(() => label)

          const createdAt = Timestamp.now()

          if (data.tracking && shippingLine) {
            // update order and add traking code
            const trackingCode = data.tracking
            const trackingCodes = shippingLine.tracking_codes || []
            trackingCodes.push({
              code: trackingCode
            })
            await appSdk.apiRequest(
              storeId,
              `/orders/${orderId}/shipping_lines/${shippingLine._id}.json`,
              'PATCH',
              { tracking_codes: trackingCodes },
              auth
            )
          }

          await getFirestore().doc(docId)
            .set({
              createdAt,
              orderId,
              storeId,
              ...data
            }, { merge: true })
            .catch(console.error)

          return res.send(ECHO_SUCCESS)
        }
      }

      return res.send(ECHO_SKIP)
    })

    .catch(err => {
      if (err.name === SKIP_TRIGGER_NAME || err.name === ECHO_SKIP) {
        // trigger ignored by app configuration
        res.send(ECHO_SKIP)
      } else if (err.appWithoutAuth === true) {
        const msg = `Webhook for ${storeId} unhandled with no authentication found`
        const error = new Error(msg)
        error.trigger = JSON.stringify(trigger)
        console.error(error)
        res.status(412).send(msg)
      } else {
        console.error(err)
        // request to Store API with error response
        // return error status code
        res.status(500)
        const { message } = err
        res.send({
          error: ECHO_API_ERROR,
          message
        })
      }
    })
}
