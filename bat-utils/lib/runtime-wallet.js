const BigNumber = require('bignumber.js')
const SDebug = require('sdebug')
const UpholdSDK = require('@uphold/uphold-sdk-javascript')
const bitcoinjs = require('bitcoinjs-lib')
const crypto = require('crypto')
const underscore = require('underscore')
const { verify } = require('http-request-signature')

const braveHapi = require('./extras-hapi')
const Currency = require('./runtime-currency')

const debug = new SDebug('wallet')

const Wallet = function (config, runtime) {
  if (!(this instanceof Wallet)) return new Wallet(config, runtime)

  if (!config.wallet) return

  this.config = config.wallet
  this.runtime = runtime
  if (config.wallet.uphold) {
    if ((process.env.FIXIE_URL) && (!process.env.HTTPS_PROXY)) process.env.HTTPS_PROXY = process.env.FIXIE_URL

    const upholdBaseUrls = {
      'prod': 'https://api.uphold.com',
      'sandbox': 'https://api-sandbox.uphold.com'
    }
    this.uphold = new UpholdSDK.default({ // eslint-disable-line new-cap
      baseUrl: upholdBaseUrls[this.config.uphold.environment],
      clientId: this.config.uphold.clientId,
      clientSecret: this.config.uphold.clientSecret
    })
    this.uphold.storage.setItem('uphold.access_token', this.config.uphold.accessToken)
  }

  if (config.currency) {
    this.currency = new Currency(config, runtime)
  }
}

Wallet.prototype.create = async function (requestType, request) {
  let f = Wallet.providers.mock.create
  if (this.config.uphold) {
    f = Wallet.providers.uphold.create
  }
  if (!f) return {}
  return f.bind(this)(requestType, request)
}

Wallet.prototype.balances = async function (info) {
  const f = Wallet.providers[info.provider].balances

  if (!f) throw new Error('provider ' + info.provider + ' balances not supported')
  return f.bind(this)(info)
}

Wallet.prototype.transfer = async function (info, satoshis) {
  const f = Wallet.providers[info.provider].transfer

  if (!f) throw new Error('provider ' + info.provider + ' transfer not supported')
  return f.bind(this)(info, satoshis)
}

Wallet.prototype.getTxProbi = function (info, txn) {
  if (info.altcurrency === 'BTC') {
    const tx = bitcoinjs.Transaction.fromHex(txn)
    for (let i = tx.outs.length - 1; i >= 0; i--) {
      if (bitcoinjs.address.fromOutputScript(tx.outs[i].script) !== this.config.settlementAddress['BTC']) continue

      return new BigNumber(tx.outs[i].value)
    }
  } else if (info.altcurrency === 'BAT' && (info.provider === 'uphold' || info.provider === 'mockHttpSignature')) {
    return new BigNumber(txn.denomination.amount).times(this.currency.alt2scale(info.altcurrency))
  } else {
    throw new Error('getTxProbi not supported for ' + info.altcurrency + ' at ' + info.provider)
  }

  return new BigNumber(0)
}

Wallet.prototype.validateTxSignature = function (info, txn, signature) {
  if (info.altcurrency === 'BTC') {
    const signedTx = bitcoinjs.Transaction.fromHex(signature)
    const unsignedTx = bitcoinjs.Transaction.fromHex(txn)

    if ((unsignedTx.version !== signedTx.version) || (unsignedTx.locktime !== signedTx.locktime)) {
      throw new Error('the signed and unsigned transactions differed')
    }

    if (unsignedTx.ins.length !== signedTx.ins.length) {
      throw new Error('the signed and unsigned transactions differed')
    }
    for (let i = 0; i < unsignedTx.ins.length; i++) {
      if (!underscore.isEqual(underscore.omit(unsignedTx.ins[i], 'script'), underscore.omit(signedTx.ins[i], 'script'))) {
        throw new Error('the signed and unsigned transactions differed')
      }
    }

    if (!underscore.isEqual(unsignedTx.outs, signedTx.outs)) throw new Error('the signed and unsigned transactions differed')
  } else if (info.altcurrency === 'BAT' && (info.provider === 'uphold' || info.provider === 'mockHttpSignature')) {
    if (!signature.headers.digest) throw new Error('a valid http signature must include the content digest')
    if (!underscore.isEqual(txn, JSON.parse(signature.octets))) throw new Error('the signed and unsigned transactions differed')
    const expectedDigest = 'SHA-256=' + crypto.createHash('sha256').update(signature.octets, 'utf8').digest('base64')
    if (expectedDigest !== signature.headers.digest) throw new Error('the digest specified is not valid for the unsigned transaction provided')

    const result = verify({headers: signature.headers, publicKey: info.httpSigningPubKey}, { algorithm: 'ed25519' })
    if (!result.verified) throw new Error('the http-signature is not valid')
  } else {
    throw new Error('wallet validateTxSignature for requestType ' + info.requestType + ' not supported for altcurrency ' + info.altcurrency)
  }
}

Wallet.prototype.submitTx = async function (info, txn, signature) {
  const f = Wallet.providers[info.provider].submitTx

  if (!f) throw new Error('provider ' + info.provider + ' submitTx not supported')
  return f.bind(this)(info, txn, signature)
}

Wallet.prototype.unsignedTx = async function (info, amount, currency, balance) {
  const f = Wallet.providers[info.provider].unsignedTx

  if (!f) throw new Error('provider ' + info.provider + ' unsignedTx not supported')
  return f.bind(this)(info, amount, currency, balance)
}

Wallet.providers = {}

Wallet.providers.uphold = {
  create: async function (requestType, request) {
    if (requestType === 'httpSignature') {
      const altcurrency = request.body.currency
      if (altcurrency === 'BAT') {
        const wallet = await this.uphold.api('/me/cards', ({ body: request.octets, method: 'post', headers: request.headers }))
        const ethAddr = await this.uphold.createCardAddress(wallet.id, 'ethereum')
        const btcAddr = await this.uphold.createCardAddress(wallet.id, 'bitcoin')
        const ltcAddr = await this.uphold.createCardAddress(wallet.id, 'litecoin')
        return { 'wallet': { 'addresses': {
          'BAT': ethAddr.id,
          'BTC': btcAddr.id,
          'CARD_ID': wallet.id,
          'ETH': ethAddr.id,
          'LTC': ltcAddr.id
        },
          'provider': 'uphold',
          'providerId': wallet.id,
          'httpSigningPubKey': request.body.publicKey,
          'altcurrency': 'BAT' } }
      } else {
        throw new Error('wallet uphold create requestType ' + requestType + ' not supported for altcurrency ' + altcurrency)
      }
    } else {
      throw new Error('wallet uphold create requestType ' + requestType + ' not supported')
    }
  },
  balances: async function (info) {
    const cardInfo = await this.uphold.getCard(info.providerId)
    const balanceProbi = new BigNumber(cardInfo.balance).times(this.currency.alt2scale(info.altcurrency))
    const spendableProbi = new BigNumber(cardInfo.available).times(this.currency.alt2scale(info.altcurrency))
    return {
      balance: balanceProbi.toString(),
      spendable: spendableProbi.toString(),
      confirmed: spendableProbi.toString(),
      unconfirmed: balanceProbi.minus(spendableProbi).toString()
    }
  },
  unsignedTx: async function (info, amount, currency, balance) {
    if (info.altcurrency === 'BAT') {
      // TODO This logic should be abstracted out into the PUT wallet payment endpoint
      // such that this takes desired directly
      let desired = new BigNumber(amount.toString()).times(this.currency.alt2scale(info.altcurrency))

      currency = currency.toUpperCase()
      if (currency !== info.altcurrency) {
        const rate = this.currency.rates.BAT[currency]
        if (!rate) throw new Error('no conversion rate for ' + currency + ' to BAT')

        desired = desired.dividedBy(new BigNumber(rate.toString()))
      }
      const minimum = desired.times(0.90)

      debug('unsignedTx', { balance: balance, desired: desired, minimum: minimum })

      if (minimum.greaterThan(balance)) return

      desired = desired.floor()

      if (desired.greaterThan(balance)) desired = new BigNumber(balance)

      // NOTE skipping fee calculation here as transfers within uphold have none

      desired = desired.dividedBy(this.currency.alt2scale(info.altcurrency)).toFixed(this.currency.decimals[info.altcurrency]).toString()

      return { 'requestType': 'httpSignature',
        'unsignedTx': { 'denomination': { 'amount': desired, currency: 'BAT' },
          'destination': this.config.settlementAddress['BAT']
        }
      }
    } else {
      throw new Error('wallet uphold unsignedTx for ' + info.altcurrency + ' not supported')
    }
  },
  submitTx: async function (info, txn, signature) {
    if (info.altcurrency === 'BAT') {
      const postedTx = await this.uphold.createCardTransaction(info.providerId,
        // this will be replaced below, we're just placating
        underscore.pick(underscore.extend(txn.denomination, {'destination': txn.destination}), ['amount', 'currency', 'destination']),
        true, // commit tx in one swoop
        null, // no otp code
        {'headers': signature.headers, 'body': signature.octets}
      )

      if (postedTx.fees.length !== 0) { // fees should be 0 with an uphold held settlement address
        throw new Error(`unexpected fee(s) charged: ${JSON.stringify(postedTx.fees)}`)
      }

      return {
        probi: new BigNumber(postedTx.destination.amount).times(this.currency.alt2scale(info.altcurrency)).toString(),
        altcurrency: info.altcurrency,
        address: txn.destination,
        fee: 0,
        status: postedTx.status
      }
    } else {
      throw new Error('wallet uphold submitTx for ' + info.altcurrency + ' not supported')
    }
  },
  status: async function (provider, parameters) {
    const result = {}
    let user

    user = await braveHapi.wreck.get('https://' + provider + '/v0/me', {
      headers: {
        authorization: 'Bearer ' + parameters.access_token,
        'content-type': 'application/json'
      },
      useProxyP: true
    })
    if (Buffer.isBuffer(user)) user = JSON.parse(user)
    console.log('/v0/me: ' + JSON.stringify(user, null, 2))

    user = { authorized: [ 'restricted', 'ok' ].indexOf(user.status) !== -1, address: user.username }
    if (this.currency.fiatP(user.settings.currency)) result.fiat = user.settings.currency
    console.log('result: ' + JSON.stringify(result, null, 2))

    return result
  }
}

Wallet.providers.mock = {
  create: async function (requestType, request) {
    if (requestType === 'bitcoinMultisig') {
      return { 'wallet': { 'addresses': {'BTC': request.keychains.user.xpub}, 'provider': 'mock', 'altcurrency': 'BTC' } }
    } else if (requestType === 'httpSignature') {
      const altcurrency = request.body.currency
      if (altcurrency === 'BAT') {
        // TODO generate random addresses?
        return { 'wallet': { 'addresses': {
          'BAT': this.config.settlementAddress['BAT']
        },
          'provider': 'mockHttpSignature',
          'httpSigningPubKey': request.body.publicKey,
          'altcurrency': 'BAT' } }
      } else {
        throw new Error('wallet mock create requestType ' + requestType + ' not supported for altcurrency ' + altcurrency)
      }
    } else {
      throw new Error('wallet mock create requestType ' + requestType + ' not supported')
    }
  },
  balances: async function (info) {
    if (info.altcurrency === 'BTC') {
      return {
        balance: '845480',
        spendable: '845480',
        confirmed: '845480',
        unconfirmed: '0'
      }
    } else if (info.altcurrency === 'BAT') {
      return {
        balance: '32061750000000000000',
        spendable: '32061750000000000000',
        confirmed: '32061750000000000000',
        unconfirmed: '0'
      }
    } else {
      throw new Error('wallet mock balances for ' + info.altcurrency + ' not supported')
    }
  },
  unsignedTx: async function (info, amount, currency, balance) {
    if (info.altcurrency === 'BTC') {
      var tx = new bitcoinjs.TransactionBuilder()
      var txId = 'aa94ab02c182214f090e99a0d57021caffd0f195a81c24602b1028b130b63e31'
      tx.addInput(txId, 0)
      tx.addOutput(this.config.settlementAddress['BTC'], 845480)

      return { 'requestType': 'bitcoinMultisig',
        'unsignedTx': { 'transactionHex': tx.buildIncomplete().toHex() }
      }
    } else if (info.altcurrency === 'BAT' && info.provider === 'mockHttpSignature') {
      return { 'requestType': 'httpSignature',
        'unsignedTx': { 'denomination': { 'amount': '24.1235', currency: 'BAT' },
          'destination': this.config.settlementAddress['BAT']
        }
      }
    } else {
      throw new Error('wallet mock unsignedTx for ' + info.altcurrency + ' not supported')
    }
  },
  submitTx: async function (info, txn, signature) {
    if (info.altcurrency === 'BTC') {
      const tx = bitcoinjs.Transaction.fromHex(txn)
      return {
        probi: tx.outs[0].value.toString(),
        altcurrency: 'BTC',
        address: bitcoinjs.address.fromOutputScript(tx.outs[0].script),
        fee: '300',
        status: 'accepted',
        hash: 'deadbeef'
      }
    } else if (info.altcurrency === 'BAT') {
      return {
        probi: new BigNumber(txn.denomination.amount).times(this.currency.alt2scale(info.altcurrency)).toString(),
        altcurrency: txn.denomination.currency,
        address: txn.destination,
        fee: '300',
        status: 'accepted'
      }
    }
  }
}
Wallet.providers.mockHttpSignature = Wallet.providers.mock

module.exports = Wallet
