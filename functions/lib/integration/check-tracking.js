const { isSandbox } = require('../../__env')
const Superfrete = require('./../superfrete/client')
const getAppData = require('../store-api/get-app-data')
const { setup } = require('@ecomplus/application-sdk')
const { Timestamp, getFirestore } = require('firebase-admin/firestore')

/*
  canceled = Cancelado.
  pending = Aguardando pagamento.
  released = Liberado para postagem.
  posted = Postado.
  delivered = Entregue.
// */

// ordem do fluxo de entrega na E-Com Plus, para nunca regredir o status
// (ex.: etiqueta `pending` não pode voltar pedido "Pronto para envio" para "Em separação")
const FULFILLMENT_FLOW = [
  'in_production',
  'in_separation',
  'invoice_issued',
  'ready_for_shipping',
  'partially_shipped',
  'shipped',
  'partially_delivered',
  'delivered'
]

const isForwardStatus = (current, next) => {
  if (!current) return true
  if (current === next) return false
  const currentIndex = FULFILLMENT_FLOW.indexOf(current)
  const nextIndex = FULFILLMENT_FLOW.indexOf(next)
  // status fora do fluxo (ex.: devolução) não é sobrescrito
  if (currentIndex === -1 || nextIndex === -1) return false
  return nextIndex > currentIndex
}

const parseStatus = (status) => {
  switch (status) {
    case 'pending':
      return 'in_separation'
    case 'released':
      return 'ready_for_shipping'
    case 'posted':
      return 'shipped'
    default:
      return status
  }
}

const listStoreIds = async () => {
  const storeIds = []
  const date = new Date()
  date.setHours(date.getHours() - 48)
  return getFirestore()
    .collection('ecomplus_app_auth')
    .where('updated_at', '>', Timestamp.fromDate(date))
    .get().then(querySnapshot => {
      querySnapshot.forEach(documentSnapshot => {
        const storeId = documentSnapshot.get('store_id')
        if (storeIds.indexOf(storeId) === -1) {
          storeIds.push(storeId)
        }
      })
      return storeIds
    })
}

const handleShipping = async ({ appSdk, storeId, auth }, superfreteApi, shippingsDoc) => {
  const { id, orderId, status: docStatus } = shippingsDoc
  console.log('>> Order ', orderId)
  const order = await appSdk.apiRequest(storeId, `/orders/${orderId}.json`, 'GET', null, auth)
    .then(({ response }) => {
      return response.data
    })
  const { shipping_lines: shippingLines } = order
  const shippingLine = shippingLines && shippingLines[0]

  const data = await superfreteApi.get(`/order/info/${id}`)
    .then(({ data }) => data)
    .catch((err) => {
      console.error(`>> Failed to get SuperFrete order ${id}`, err.response?.data || err.message)
      return null
    })
  if (!data) {
    return null
  }

  const docId = `shippings/${storeId}_${orderId}`
  let response = data
  const promises = []

  if (data.status === 'pending') {
    // paga a etiqueta com o saldo da carteira SuperFrete
    response = await superfreteApi.post('/checkout', { orders: [id] })
      .then(async () => {
        const { data } = await superfreteApi.get(`/order/info/${id}`)
        return data
      })
      .catch((err) => {
        console.error(`>> Failed checkout for SuperFrete order ${id}`, err.response?.data || err.message)
        return data
      })
  }

  // rastreio só é disponibilizado a partir do status `released`
  const trackingCode = response.tracking
  const trackingCodes = (shippingLine && shippingLine.tracking_codes) || []
  if (trackingCode && shippingLine && !trackingCodes.some(({ code }) => code === trackingCode)) {
    trackingCodes.push({
      code: trackingCode
    })
    promises.push(
      appSdk.apiRequest(
        storeId,
        `/orders/${orderId}/shipping_lines/${shippingLine._id}.json`,
        'PATCH',
        { tracking_codes: trackingCodes },
        auth
      )
    )
  }

  if (response) {
    if (response.status && !['canceled', 'cancelled'].includes(response.status)) {
      const fulfillmentStatus = parseStatus(response.status)
      const dateNow = new Date()
      if (
        fulfillmentStatus &&
        isForwardStatus(order.fulfillment_status && order.fulfillment_status.current, fulfillmentStatus)
      ) {
        console.log('>> update fulfillment status: ', fulfillmentStatus)
        promises.push(
          appSdk.apiRequest(storeId, `/orders/${order._id}/fulfillments.json`, 'POST', {
            status: fulfillmentStatus,
            flags: ['superfrete-tracking'],
            date_time: dateNow.toISOString()
          })
        )
      }
    }

    if (response.status !== docStatus) {
      // update doc in firestore
      promises.push(
        getFirestore().doc(docId)
          .set({
            updetedAtDoc: Timestamp.now(),
            ...response
          }, { merge: true })
          .catch(console.error)
      )
    }
  }

  return Promise.all(promises)
    .then(() => {
      console.log('>> finish order ', orderId)
    })
}

const checkTracking = async ({ appSdk, storeId }) => {
  console.log('>Store: ', storeId)
  const querySnapshot = await getFirestore()
    .collection('shippings')
    .where('storeId', '==', storeId)
    .get()

  // console.log('>> docs ', querySnapshot.docs?.length || 0)
  const shippingsDoc = []

  let j = 0
  while (j < querySnapshot.docs.length) {
    const docSnapshot = querySnapshot.docs[j]
    if (docSnapshot.exists) {
      const docData = await docSnapshot.ref.get()
      const doc = docData.data()
      if (!['delivered', 'canceled', 'cancelled'].includes(doc.status)) {
        shippingsDoc.push(doc)
      }
    }

    j += 1
  }

  const promises = []
  if (shippingsDoc.length) {
    const auth = await appSdk.getAuth(storeId)
    const appData = await getAppData({ appSdk, storeId, auth })
    const { token } = appData
    const superfreteApi = new Superfrete(token, isSandbox)
    let i = 0
    while (i < shippingsDoc.length) {
      const { orderId } = shippingsDoc[i]
      // isola a falha de um pedido para não derrubar os demais da loja
      promises.push(
        handleShipping({ appSdk, storeId, auth }, superfreteApi, shippingsDoc[i])
          .catch((err) => {
            console.error(`>> Failed to handle order ${orderId}`, err.response?.data || err.message)
          })
      )
      i += 1
    }
  }

  return Promise.all(promises)
    .then(() => {
      console.log('> End Store: ', storeId)
    })
}

module.exports = context => setup(null, true, getFirestore())
  .then(async appSdk => {
    const storeIds = await listStoreIds()
    console.log('> stores: ', storeIds.length)
    const promises = []
    storeIds.forEach(storeId => {
      promises.push(checkTracking({ appSdk, storeId }))
    })

    await Promise.all(promises)
      .then(() => {
        console.log('> Finish All Stores ', storeIds.length)
      })
  })
  .catch(console.error)
