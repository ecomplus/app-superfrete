const Superfrete = require('./../../../lib/superfrete/client')
const ecomUtils = require('@ecomplus/utils')
const { isSandbox } = require('./../../../__env')

const checkZipCode = (destinationZip, rule) => {
  // validate rule zip range
  if (destinationZip && rule.zip_range) {
    const { min, max } = rule.zip_range
    return Boolean((!min || destinationZip >= min) && (!max || destinationZip <= max))
  }
  return true
}

const isDisabledService = (destinationZip, disableServices, shipping) => {
  if (Array.isArray(disableServices)) {
    for (let i = 0; i < disableServices.length; i++) {
      const rule = disableServices[i]
      if (rule && checkZipCode(destinationZip, rule) &&
        (rule.service === 'Todos' || rule.service === shipping.name)) {
        return true
      }
    }
  }
  return false
}

const applyShippingDiscount = (destinationZip, totalItems, shippingRules, shipping) => {
  let value = shipping.price
  if (Array.isArray(shippingRules)) {
    for (let i = 0; i < shippingRules.length; i++) {
      const rule = shippingRules[i]
      if (
        rule &&
        checkZipCode(destinationZip, rule) &&
        (rule.service === 'Todos' || rule.service === shipping.name) &&
        totalItems >= rule.min_amount
      ) {
        if (rule.free_shipping) {
          value = 0
          break
        } else if (rule.discount) {
          let discountValue = rule.discount.value
          if (rule.discount.percentage || rule.discount.type === 'Percentual') {
            discountValue *= (value / 100)
          } else if (rule.discount.type === 'Percentual no subtotal') {
            discountValue *= (totalItems / 100)
          }
          if (discountValue) {
            value -= discountValue
            if (value < 0) {
              value = 0
            }
          }
          break
        } else if (rule.fixed) {
          value = rule.fixed
          break
        }
      }
    }
  }
  return value
}

exports.post = async ({ appSdk }, req, res) => {
  /**
   * Treat `params` and (optionally) `application` from request body to properly mount the `response`.
   * JSON Schema reference for Calculate Shipping module objects:
   * `params`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
   * `response`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
   *
   * Examples in published apps:
   * https://github.com/ecomplus/app-mandabem/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-datafrete/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-jadlog/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   */

  const { params, application } = req.body
  // const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }
  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    res.send(response)
    return
  }

  const formatZipCode = str => str.replace(/\D/g, '').padStart(8, '0')
  const zipTo = params.to ? formatZipCode(params.to.zip) : ''
  const zipFrom = params.from
    ? formatZipCode(params.from.zip)
    : appData.zip ? formatZipCode(appData.zip) : ''

  // search for configured free shipping rule
  if (Array.isArray(appData.shipping_rules)) {
    for (let i = 0; i < appData.shipping_rules.length; i++) {
      const rule = appData.shipping_rules[i]
      if (rule.free_shipping && checkZipCode(zipTo, rule)) {
        if (!rule.min_amount) {
          response.free_shipping_from_value = 0
          break
        } else if (!(response.free_shipping_from_value <= rule.min_amount)) {
          response.free_shipping_from_value = rule.min_amount
        }
      }
    }
  }

  if (!params.items) {
    return res.status(400).send({
      error: 'CALCULATE_EMPTY_CART',
      message: 'Cannot calculate shipping without cart items'
    })
  }

  const products = []
  const {
    items,
    own_hand: ownHand,
    receipt,
    // service_code: serviceCode,
    subtotal
  } = params

  let insuranceValue = subtotal || 0

  const body = {
    from: {
      postal_code: zipFrom
    },
    to: {
      postal_code: zipTo
    },
    services: '1,2,17'
  }

  let kgWeightBiggerBox = 0
  let totalItems = 0
  const cmDimensionsBiggerBox = {}

  items?.forEach((item) => {
    const { quantity, dimensions, weight, price } = item
    if (quantity) {
      totalItems += (ecomUtils.price(item) * item.quantity)
      if (!params.subtotal && !appData.no_declare_value) {
        insuranceValue += price * quantity
      }
      const product = { quantity }
      if (weight && weight.value) {
        let weightValue
        switch (weight.unit) {
          case 'kg':
            weightValue = weight.value
            break
          case 'g':
            weightValue = weight.value / 1000
            break
          case 'mg':
            weightValue = weight.value / 1000000
            break
          default:
            weightValue = weight.value
            break
        }
        if (weightValue) {
          product.weight = weightValue
          kgWeightBiggerBox += weightValue * quantity
        }
      }

      if (dimensions) {
        for (const side in dimensions) {
          const dimension = dimensions[side]
          if (dimension && dimension.value) {
            let dimensionValue
            switch (dimension.unit) {
              case 'cm':
                dimensionValue = dimension.value
                break
              case 'm':
                dimensionValue = dimension.value * 100
                break
              case 'mm':
                dimensionValue = dimension.value / 10
                break
              default:
                dimensionValue = dimension.value
                break
            }
            if (dimensionValue) {
              if (!cmDimensionsBiggerBox[side] || cmDimensionsBiggerBox[side] < dimensionValue) {
                cmDimensionsBiggerBox[side] = dimensionValue
              }
              product[side] = dimensionValue
            }
          }
        }
      }

      products.push(product)
    }
  })

  if (products.length && !appData.use_bigger_box) {
    Object.assign(body, { products })
  } else {
    Object.assign(body, { package: { ...cmDimensionsBiggerBox, weight: kgWeightBiggerBox } })
  }

  if (ownHand || receipt) {
    const useInsuranceValue = Boolean(insuranceValue)
    const options = {
      own_hand: ownHand,
      receipt,
      insurance_value: insuranceValue,
      use_insurance_value: useInsuranceValue
    }
    Object.assign(body, { options })
  }

  try {
    const superfreteApi = new Superfrete(appData.token, isSandbox)
    const { data } = await superfreteApi.post('/calculator', body)

    data.forEach(shipping => {
      if (!shipping.error) {
        if (!isDisabledService(zipTo, appData.disable_services, shipping)) {
          let totalPrice = applyShippingDiscount(zipTo, totalItems, appData.shipping_rules, shipping)
          if (appData.additional_price && totalPrice) {
            totalPrice += appData.additional_price
          }
          if (totalPrice < 0) {
            totalPrice = 0
          }
          const discount = totalPrice === 0 ? shipping.price : shipping.price - totalPrice

          const shippingLine = {
            from: {
              ...params.from,
              zip: zipFrom
            },
            to: params.to,
            price: shipping.price,
            total_price: totalPrice,
            declared_value: insuranceValue | 0,
            declared_value_price: insuranceValue | 0,
            own_hand: Boolean(shipping.additional_services?.own_hand),
            receipt: Boolean(shipping.additional_services?.receipt),
            discount,
            delivery_time: {
              days: Number(shipping.delivery_time)
            },
            posting_deadline: {
              days: 3,
              ...appData.posting_deadline
            },
            flags: ['superfrete-ws']
          }
          const service = {
            label: shipping.name,
            carrier: shipping.company.name,
            service_name: 'Superfrete',
            service_code: `Superfrete_${shipping.name}`,
            shipping_line: shippingLine
          }

          if (shipping.packages?.length) {
            const pkg = {
              dimensions: {
                width: {
                  value: 0,
                  unit: 'cm'
                },
                height: {
                  value: 0,
                  unit: 'cm'
                },
                length: {
                  value: 0,
                  unit: 'cm'
                }
              },
              weight: {
                value: 0,
                unit: 'kg'
              }
            }

            shipping.packages.forEach(shippingPkg => {
              const { dimensions } = shippingPkg
              pkg.weight.value += Number(shippingPkg.weight) || 0
              if (dimensions) {
                for (const side in dimensions) {
                  const dimension = Number(dimensions[side])
                  if (appData.use_bigger_box) {
                    // sum dimension
                    pkg.dimensions[side].value += dimension || 0
                  } else {
                    // select max dimension
                    pkg.dimensions[side].value = Math.max(pkg.dimensions[side].value, dimension)
                  }
                }
              }
            })
            // console.log(appData.use_bigger_box, ' pkg ', JSON.stringify(pkg))
            shippingLine.package = pkg
          }

          response.shipping_services.push(service)
        }
      }
    })

    return res.send(response)
  } catch (err) {
    // console.error(err)
    return res.status(409).send({
      error: 'CALCULATE_FAILED',
      message: response?.data?.[0]?.txErro || err.message
    })
  }
}
