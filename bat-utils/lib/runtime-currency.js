const BigNumber = require('bignumber.js')
const bitcoinaverage = require('node-bitcoinaverage-api')
const Client = require('signalr-client-forked').client
const Joi = require('joi')
const NodeCache = require('node-cache')
const SDebug = require('sdebug')
const currencyCodes = require('currency-codes')
const debug = new SDebug('currency')
const underscore = require('underscore')

const braveHapi = require('./extras-hapi')

const fiats = [ 'USD', 'EUR', 'GBP' ]

const msecs = {
  day: 24 * 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  minute: 60 * 1000,
  second: 1000
}

let client
let singleton

const Currency = function (config, runtime) {
  if (!(this instanceof Currency)) return new Currency(config, runtime)

  if (!config.currency || config.currency.static) return

  this.config = config.currency
  this.runtime = runtime

  this.informs = 0
  this.warnings = 0
  this.cache = new NodeCache({ stdTTL: 1 * msecs.minute })

  this.fiats = {}
  this.rates = Currency.prototype.rates
  this.tickers = {}

  if (!this.config.altcoins) this.config.altcoins = [ 'BAT', 'ETH' ]
  if ((this.config.altcurrency) && (this.config.altcoins.indexOf(this.config.altcurrency) === -1)) {
    this.config.altcoins.push(this.config.altcurrency)
  }
  this.config.allcoins = underscore.clone(this.config.altcoins)
  fiats.forEach((fiat) => {
    if (this.config.allcoins.indexOf(fiat) === -1) {
      this.config.allcoins.push(fiat)
    }
    this.fiats[fiat] = true
  })
}
Currency.prototype.rates = {}

Currency.prototype.init = function () {
  this.config.altcoins.forEach((altcoin) => {
    const f = altcoins[altcoin]

    if ((f) && (f.p)) f.p(this.config, this.runtime)
  })

  maintenance(this.config, this.runtime)
  setInterval(function () { maintenance(this.config, this.runtime) }.bind(this), 5 * msecs.minute)

  monitor1(this.config, this.runtime)
}

const schemaSR =
      Joi.array().min(1).items(Joi.object().keys({
        MarketName: Joi.string().regex(/^[0-9A-Z]{2,}-[0-9A-Z]{2,}$/).required(),
        Last: Joi.number().positive().required()
      }).unknown(true)).required()

const monitor1 = (config, runtime) => {
  const retry = () => {
    try { if (client) client.end() } catch (ex) { debug('monitor1', { event: 'end', message: ex.toString() }) }

    client = undefined
    setTimeout(function () { monitor1(config, runtime) }, 15 * msecs.second)
  }

  if (client) return

  client = new Client('http://socket.bittrex.com/signalR', [ 'coreHub' ])

  client.on('coreHub', 'updateSummaryState', async (data) => {
    const validity = Joi.validate(data.Deltas, schemaSR)
    let now
    let tickers
    let rates = {}

    if (validity.error) {
      retry()
      return runtime.captureException(validity.error)
    }

    data.Deltas.forEach((delta) => {
      const pair = delta.MarketName.split('-')
      const src = pair[0]
      const dst = pair[1]

      if ((src === dst) || (config.allcoins.indexOf(src) === -1) || (config.allcoins.indexOf(dst) === -1)) return

      if (!rates[src]) rates[src] = {}
      rates[src][dst] = 1.0 / delta.Last

      if (!rates[dst]) rates[dst] = {}
      rates[dst][src] = delta.Last
    })

    try { tickers = await inkblot(config, runtime) } catch (ex) {
      console.log(ex.stack)

      now = underscore.now()
      if (singleton.warnings > now) return

      singleton.warnings = now + (15 * msecs.minute)
      return runtime.captureException(ex)
    }

    try { await rorschach(rates, tickers, config, runtime) } catch (ex) {
      console.log(ex.stack)

      now = underscore.now()
      if (singleton.warnings > now) return

      singleton.warnings = now + (15 * msecs.minute)
      return runtime.captureException(ex)
    }
  })

  client.serviceHandlers.connected = client.serviceHandlers.reconnected = (connection) => {
    debug('monitor1', { event: 'connected', connected: connection.connected })
    if (!connection.connected) retry()
  }
  client.serviceHandlers.connectFailed = (err) => {
    debug('monitor1', { event: 'connectFailed', message: err.toString() })
    retry()
  }
  client.serviceHandlers.connectionLost = (err) => {
    debug('monitor1', { event: 'connectionLost', message: err.toString() })
    retry()
  }
  client.serviceHandlers.onerror = (err) => {
    debug('monitor1', { event: 'err', message: err.toString() })
    retry()
  }
  client.serviceHandlers.disconnected = () => {
    debug('monitor1', { event: 'disconnected' })
    retry()
  }
}

const altcoins = {
  BAT: {
    id: 'basic-attention-token'
  },

  BTC: {
    id: 'bitcoin',

    p: (config, runtime) => {
      if (!config.bitcoin_average) throw new Error('config.bitcoin_average undefined')

      if (!config.bitcoin_average.publicKey) throw new Error('config.bitcoin_average.publicKey undefined')

      if (!config.bitcoin_average.secretKey) throw new Error('config.bitcoin_average.secretKey undefined')

      monitor2('BTC', config, runtime)
    },

    f: async (tickers, config, runtime) => {
      const fiats = singleton.cache.get('fiats:BTC')
      const rates = {}
      const unavailable = []
      let now, rate

      if (!fiats) return

      fiats.forEach((fiat) => {
        rate = singleton.cache.get('ticker:BTC' + fiat)
        rates[fiat] = (rate && rate.last) || (unavailable.push(fiat) && undefined)
      })
      if (unavailable.length > 0) {
        return runtime.captureException('BTC.f fiat error: ' + unavailable.join(', ') + ' unavailable')
      }

      try { await rorschach({ BTC: rates }, tickers, config, runtime) } catch (ex) {
        console.log(ex.stack)

        now = underscore.now()
        if (singleton.warnings > now) return

        singleton.warnings = now + (15 * msecs.minute)
        return runtime.captureException(ex)
      }
    }
  },

  ETH: {
    id: 'ethereum'
  }
}

const monitor2 = (altcoin, config, runtime) => {
  const publicKey = config.bitcoin_average.publicKey
  const secretKey = config.bitcoin_average.secretKey

  bitcoinaverage.restfulClient(publicKey, secretKey).symbolsGlobal((err, result) => {
    const c2s = {
      1000: 10,     /* normal */
      1001: 60,     /* going away */
      1011: 60,     /* unexpected condition */
      1012: 60,     /* service restart */
      1013: 300     /* try again later */
    }
    const eligible = []
    let symbols

    if (err) return console.error(err)

    const pairing = (symbol) => {
      bitcoinaverage.websocketClient(publicKey, secretKey).connectToTickerWebsocket('global', symbol, (tag, type, data) => {
        const f = {
          open: () => {
            if (data.operation === 'subscribe') return debug('monitor2', { tag: tag, event: 'subscribed' })
          },

          message: async () => {
            if (data.event === 'message') singleton.cache.set('ticker:' + symbol, data.data)
          },

          error: () => {
            debug('monitor2', underscore.defaults({ type: type, tag: tag }, data))
            if (data.reason) {
              runtime.captureException(data.reason, { extra: underscore.defaults({ type: type, tag: tag }, data) })
            } else {
              runtime.captureException(underscore.defaults({ type: type, tag: tag }, data))
            }
            setTimeout(() => { pairing(symbol) }, (c2s[data.code] || 600) * msecs.second)
          },

          close: () => {
            debug('monitor2', underscore.defaults({ type: type, tag: tag }, data))
            setTimeout(() => { pairing(symbol) }, (c2s[data.code] || 600) * msecs.second / (data.wasClean ? 2 : 1))
          },

          internal: () => {
            if (data.type !== 'status') return

            debug('monitor2', underscore.defaults({ type: type, tag: tag }, data))
          }
        }[type]
        if (f) return f()
      })
    }

    try {
      symbols = JSON.parse(result).symbols
    } catch (ex) {
      console.log(ex.stack)
      return runtime.captureException(ex)
    }

    fiats.forEach((fiat) => {
      const symbol = altcoin + fiat

      if (symbols.indexOf(symbol) === -1) return

      eligible.push(fiat)
      pairing(symbol)
    })

    singleton.cache.set('fiats:' + altcoin, eligible)
  })
}

const maintenance = async (config, runtime) => {
  let tickers

  try { tickers = await inkblot(config, runtime) } catch (ex) {
    console.log(ex.stack)
    return runtime.captureException(ex)
  }

  config.altcoins.forEach((altcoin) => {
    const f = altcoins[altcoin]

    if ((f) && (f.f)) f.f(tickers, config, runtime)
  })
}

const retrieve = async (url, props, schema) => {
  let result, validity

  result = singleton.cache.get('url:' + url)
  if (result) return result

  result = await braveHapi.wreck.get(url, props || {})
  if (Buffer.isBuffer(result)) result = result.toString()
// courtesy of https://stackoverflow.com/questions/822452/strip-html-from-text-javascript#822464
  if (result.indexOf('<html>') !== -1) throw new Error(result.replace(/<(?:.|\n)*?>/gm, ''))

  result = JSON.parse(result)
  validity = schema ? Joi.validate(result, schema) : {}
  if (validity.error) throw new Error(validity.error)

  singleton.cache.set('url:' + url, result)
  return result
}

const schemaCMC =
      Joi.object().keys({
        symbol: Joi.string().regex(/^[A-Z]{3}$/).required(),
        price_btc: Joi.number().positive().required(),
        price_usd: Joi.number().positive().required()
      }).unknown(true).required()
const inkblot = async (config, runtime) => {
  const unavailable = []
  let tickers = {}

  const ticker = async (fiat) => {
    let entries

    try {
      entries = await retrieve('https://api.coinmarketcap.com/v1/ticker/?convert=' + fiat)
    } catch (ex) {
      ex.message = fiat + ': ' + ex.message
      throw ex
    }
    entries.forEach((entry) => {
      const src = entry.symbol
      const validity = Joi.validate(entry, schemaCMC)

      if (config.allcoins.indexOf(src) === -1) return

      if (!altcoins[src]) return runtime.captureException('monitor ticker error: no entry for altcoins[' + src + ']')

      if (altcoins[src].id !== entry.id) return

      if (validity.error) return runtime.captureException('monitor ticker error: ' + validity.error)

      underscore.keys(entry).forEach((key) => {
        const dst = key.substr(6).toUpperCase()

        if ((src === dst) || (key.indexOf('price_') !== 0)) return

        if (!tickers[src]) tickers[src] = {}
        tickers[src][dst] = entry[key]

        if (!tickers[dst]) tickers[dst] = {}
        tickers[dst][src] = 1.0 / entry[key]
      })
    })
  }

  for (let i = fiats.length - 1; i >= 0; i--) {
    let fiat = fiats[i]

    if (((fiat !== 'USD') || (fiats.length === 1)) && (!tickers[fiat])) await ticker(fiat)
  }
  fiats.forEach((fiat) => { if (!tickers[fiat]) unavailable.push(fiat) })
  if (unavailable.length > 0) throw new Error('fiats ' + unavailable.join(', ') + ' unavailable')

  return normalize(tickers, config, runtime)
}

const rorschach = async (rates, tickers, config, runtime) => {
  let informP, now

  const compare = (currency, fiat, rate1, rate2) => {
    const ratio = rate1 / rate2

    if ((ratio < 0.9) || (ratio > 1.1)) throw new Error(currency + ' error: ' + fiat + ' ' + rate1 + ' vs. ' + rate2)
  }

  rates = normalize(rates, config, runtime)

  fiats.forEach((fiat) => {
    config.altcoins.forEach((altcoin) => {
      if (rates[altcoin][fiat]) compare(altcoin, fiat, rates[altcoin][fiat], tickers[altcoin][fiat])
    })
  })

  singleton.tickers = tickers

  now = underscore.now()
  informP = singleton.informs <= now
  config.altcoins.forEach((currency) => {
    const rate = singleton.rates[currency] || {}

    singleton.rates[currency] = underscore.extend(underscore.clone(rate), rates[currency] || {})
    if ((informP) && (!underscore.isEqual(singleton.rates[currency], rate))) {
      debug(currency + ' fiat rates', JSON.stringify(underscore.pick(singleton.rates[currency], fiats)))
    }
  })
  if (informP) singleton.informs = now + (1 * msecs.minute)

  singleton.rates = normalize(singleton.rates, config, runtime)
  Currency.prototype.rates = singleton.rates
}

const normalize = (rates, config, runtime) => {
  const tickers = singleton.tickers

  config.allcoins.forEach((currency) => { if (!rates[currency]) rates[currency] = {} })

  underscore.keys(rates).forEach((src) => {
    if (config.altcoins.indexOf(src) === -1) return

    underscore.keys(tickers).forEach((dst) => {
      if (src === dst) return

      underscore.keys(rates[src]).forEach((rate) => {
        if (rates[src][dst]) return

        if (rates[dst][src]) {
          rates[src][dst] = 1.0 / rates[dst][src]
          return
        }

        if ((!tickers[rate]) || (!tickers[rate][dst]) || (!rates[src]) || (!rates[src][rate])) return

        rates[src][dst] = tickers[rate][dst] * rates[src][rate]
        rates[dst][src] = 1.0 / rates[src][dst]
      })
    })
  })

  config.allcoins.forEach((src) => {
    config.allcoins.forEach((dst) => {
      if ((src === dst) || (rates[src][dst])) return

      underscore.keys(tickers).forEach((currency) => {
        if (rates[src][dst]) return

        if (rates[dst][src]) {
          rates[src][dst] = 1.0 / rates[dst][src]
          return
        }

        if ((!tickers[currency]) || (!tickers[currency][dst]) || (!rates[src]) || (!rates[src][currency])) return

        rates[src][dst] = tickers[currency][dst] * rates[src][currency]
        rates[dst][src] = 1.0 / rates[src][dst]
      })
    })
  })

  return underscore.omit(rates, fiats)
}

Currency.prototype.fiatP = function (currency) {
  const entry = currencyCodes.code(currency)

  return Array.isArray(entry && entry.countries)
}

// satoshis, wei, etc.
Currency.prototype.decimals = {
  BAT: 18,
  BCH: 8,
  BTC: 8,
  ETC: 18,
  ETH: 18,
  LTC: 8,
  NMC: 8,
  PPC: 6,
  XPM: 8,
  ZEC: 8
}

// satoshis, wei, etc.
Currency.prototype.alt2scale = function (altcurrency) {
  const scale = Currency.prototype.decimals[altcurrency]

  if (scale) return ('1e' + scale.toString())
}

Currency.prototype.alt2fiat = function (altcurrency, probi, currency, floatP) {
  const entry = currencyCodes.code(currency)
  const rate = singleton.rates[altcurrency] && singleton.rates[altcurrency][currency]
  const scale = singleton.alt2scale(altcurrency)
  let amount

  if (!rate) return

  if (!(probi instanceof BigNumber)) probi = new BigNumber(probi.toString())
  amount = probi.times(new BigNumber(rate.toString()))
  if (scale) amount = amount.dividedBy(scale)

  if (!floatP) return amount.toFixed(entry ? entry.digits : 2)

  return amount.toNumber()
}

Currency.prototype.fiat2alt = function (currency, amount, altcurrency) {
  const rate = singleton.rates[altcurrency] && singleton.rates[altcurrency][currency]
  const scale = singleton.alt2scale(altcurrency)
  let probi

  if ((!amount) || (!rate)) return

  if (!(amount instanceof BigNumber)) amount = new BigNumber(amount.toString())
  probi = amount.dividedBy(new BigNumber(rate.toString()))

  if (scale) probi = probi.times(scale)

  return probi.floor().toString()
}

module.exports = function (config, runtime) {
  if (!singleton) {
    singleton = new Currency(config, runtime)
    if (!config.currency.static) singleton.init()
  }

  return singleton
}
