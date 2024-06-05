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
  date.setHours(date.getHours() - 72)

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

  const { data } = await superfreteApi.get(`/order/info/${id}`)
    .catch(() => null)

  const docId = `shippings/${storeId}_${orderId}`
  // console.log('>> ', docId, JSON.stringify(data))
  let response = data
  const promises = []

  if (data.status === 'pending') {
    response = await superfreteApi.post('/checkout', { orders: [id] })
      .then(async () => {
        const { data } = await superfreteApi.get(`/order/info/${id}`)
        return data
      })

    if (response.tracking && shippingLine) {
      // update order and add traking code
      const trackingCode = data.tracking
      const trackingCodes = shippingLine.tracking_codes || []
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
  }

  if (response) {
    if (response.status && response.status !== 'canceled') {
      const fulfillmentStatus = parseStatus(response.status)
      const dateNow = new Date()
      if (
        fulfillmentStatus &&
            (!order.fulfillment_status || order.fulfillment_status.current !== fulfillmentStatus)
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
      if (!['delivered', 'canceled'].includes(doc.status)) {
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
      promises.push(handleShipping({ appSdk, storeId, auth }, superfreteApi, shippingsDoc[i]))
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
