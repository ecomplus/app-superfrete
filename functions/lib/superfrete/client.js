const axios = require('axios')

// https://superfrete.readme.io/reference/primeiros-passos

class Superfrete {
  constructor (token, isSandbox) {
    if (!token) {
      throw new Error('Missing token')
    }

    this._baseURL = `https://${isSandbox ? 'sandbox' : 'api'}.superfrete.com/api/v0`

    this._request = axios.create({
      baseURL: this._baseURL,
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      timeout: 10000
    })
  }

  async get (url) {
    return this._request({
      method: 'get',
      url
    })
  }

  async post (url, data) {
    return this._request({
      method: 'post',
      url,
      data
    })
  }

  async patch (url, data) {
    return this._request({
      method: 'patch',
      url,
      data
    })
  }

  async delete (url) {
    return this._request({
      method: 'delete',
      url
    })
  }
}

module.exports = Superfrete
