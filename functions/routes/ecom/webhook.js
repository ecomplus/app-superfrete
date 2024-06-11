const getAppData = require('./../../lib/store-api/get-app-data')
const Superfrete = require('./../../lib/superfrete/client')
const { isSandbox } = require('../../__env')
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

const parseAddress = (address, store) => {
  console.log('>> ', JSON.stringify(address))
  let name = address.name
  if (!name) {
    name = store?.name ? `${store.name} ${store.domain}` : '-'
  }

  const body = {
    name,
    address: address.street || store.address || '',
    district: address.borough || 'Bairro',
    state_abbr: address.province_code || 'MG',
    postal_code: address.zip,
    city: address.city || 'Cidade'
  }

  if (address.number) {
    body.number = `${address.number}`
  }

  if (body.complement) {
    body.complement = address.complement
  }

  return body
}

const parseService = (label) => {
  // 1: PAC, 2: SEDEX, 17: Mini Envios
  if (label) {
    switch (label.toLowerCase) {
      case 'pac':
        return 1
      case 'sedex':
        return 2
      case 'mini envios':
        return 17
      default :
        return 1
    }
  }
  return 1
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
        items
        // buyers
      } = order

      const docId = `shippings/${storeId}_${orderId}`
      const doc = await getDocInFirestore(docId)
      // const buyer = buyers && buyers[0]
      const superfreteApi = new Superfrete(appData.token, isSandbox)
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
          default:
            return _statusShipping
        }
      }

      if (doc && status === 'cancelled' && !['ready_for_shipping', 'shipped', 'delivered'].includes(shippingStatus)) {
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

          const from = parseAddress(shippingLine.from, store)
          // todo send email in to
          const to = parseAddress(shippingLine.to)
          const invoice = shippingLine.invoices && shippingLine.invoices[0]

          const body = {
            from,
            to,
            service: parseService(shippingLine.app.label),
            volumes,
            products,
            options: {
              insurance_value: shippingLine.declared_value,
              own_hand: shippingLine.own_hand,
              receipt: shippingLine.receipt,
              tags: [
                {
                  tag: orderId
                }
              ]
            },
            platform: 'e-com.plus'
          }

          if (invoice) {
            const { number, access_key: key } = invoice
            body.options.invoice = { number, key }
          }

          console.log('>> Try ', JSON.stringify(body))
          const { data } = await superfreteApi.post('/cart', body)
            .then(({ data }) => {
              const id = data.id
              return superfreteApi.get(`/order/info/${id}`)
            })
            .catch((err) => {
              if (err.response) {
                console.log(err.response.data)
              } else {
                console.error(err)
              }
              throw err
            })

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
