/**
 * @typedef {object} Data
 * @property {Buffer} id
 * @property {Buffer} topic
 * @property {Object} metadata
*/

/**
 * @typedef {object} OfferData
 * @extends Data
 * @property {Buffer} remoteId
 * @property {Buffer} sessionId
 * @property {Object} offer
*/

/**
 * @typedef {object} AnswerData
 * @extends Data
 * @property {Buffer} remoteId
 * @property {Buffer} sessionId
 * @property {Object} answer
*/

/**
 * @typedef {object} CandidatesData
 * @extends Data
 * @property {Buffer} remoteId
 * @property {Array<Object>} candidates
*/

const crypto = require('crypto')
const nanomessagerpc = require('nanomessage-rpc')

const { NanoresourcePromise } = require('nanoresource-promise/emitter')
const { validate } = require('./validations')
const log = require('debug')('socketsignal:server')

const kDefineActions = Symbol('socketsignal.defineactions')
const kDefineEvents = Symbol('socketsignal.defineevents')

class SocketSignalServer extends NanoresourcePromise {
  constructor (opts = {}) {
    super()

    const { onConnect, onDisconnect, onJoin, onLeave, onLookup, onOffer, onCandidates, ...rpcOpts } = opts

    if (onConnect) this._onConnect = onConnect
    if (onDisconnect) this._onDisconnect = onDisconnect
    if (onJoin) this._onJoin = onJoin
    if (onLeave) this._onLeave = onLeave
    if (onLookup) this._onLookup = onLookup
    if (onOffer) this._onOffer = onOffer
    if (onCandidates) this._onCandidates = onCandidates

    this._rpcOpts = rpcOpts

    this.connections = new Set()
  }

  /**
   * Adds a duplex stream socket
   *
   * @param {DuplexStream} socket
   * @returns {NanomessageRPC}
   */
  async addSocket (socket) {
    await this.open()

    const rpc = nanomessagerpc(socket, this._rpcOpts)

    this[kDefineActions](rpc)
    this[kDefineEvents](rpc)

    rpc.id = crypto.randomBytes(32)

    const deleteConnection = () => {
      if (this.connections.delete(rpc)) {
        log('connection-deleted', rpc.id.toString('hex'))
        return this._onDisconnect(rpc)
      }
    }

    rpc.on('rpc-closed', deleteConnection)

    rpc.on('rpc-error', err => {
      this.emit('rpc-error', err, rpc)
    })

    await rpc.open()

    try {
      log('connection-added', rpc.id.toString('hex'))
      await this._onConnect(rpc)
      this.connections.add(rpc)
    } catch (err) {
      rpc.closed()
        .then(deleteConnection)
        .catch(deleteConnection)
        .finally(() => {
          this.emit('connection-error', err)
        })
    }

    return rpc
  }

  /**
   * Defines a behaviour when the nanoresource is opening.
   *
   * @returns {Promise}
   */
  async _open () {}

  /**
   * Defines a behaviour when the nanoresource is closing.
   *
   * @returns {Promise}
   */
  async _close () {
    await Promise.all(Array.from(this.connections.values()).map(c => c.close()))
  }

  /**
   * Event connect
   *
   * @abstract
   * @param {NanomessageRPC} rpc
   */
  async _onConnect () {}

  /**
   * Event disconnect
   *
   * @abstract
   * @param {NanomessageRPC} rpc
   */
  async _onDisconnect () {}

  /**
   * Action join
   *
   * @abstract
   * @param {NanomessageRPC} rpc
   * @param {Data} data
   * @returns {Promise<Array<Buffer>>}
   */
  async _onJoin () {}

  /**
   * Action leave
   *
   * @abstract
   * @param {NanomessageRPC} rpc
   * @param {Data} data
   * @returns {Promise}
   */
  async _onLeave () {}

  /**
   * Action lookup
   *
   * @abstract
   * @param {NanomessageRPC} rpc
   * @param {Data} data
   * @returns {Promise<Array<Buffer>>}
   */
  async _onLookup () {}

  /**
   * Action offer
   *
   * @abstract
   * @param {NanomessageRPC} rpc
   * @param {OfferData} data
   * @returns {Promise<AnswerData>}
   */
  async _onOffer () {}

  /**
   * Event candidates
   *
   * @abstract
   * @param {NanomessageRPC} rpc
   * @param {CandidatesData} data
   */
  async _onCandidates () {}

  /**
   * @private
   */
  [kDefineActions] (rpc) {
    rpc.actions({
      join: (data = {}) => {
        validate(data, {
          id: { type: 'key' },
          topic: { type: 'key' }
        })
        return this._onJoin(rpc, data)
      },
      leave: (data = {}) => {
        validate(data, {
          id: { type: 'key' },
          topic: { type: 'key', optional: true }
        })
        return this._onLeave(rpc, data)
      },
      offer: (data = {}) => {
        validate(data, {
          id: { type: 'key' },
          remoteId: { type: 'remoteId' },
          topic: { type: 'key' },
          sessionId: { type: 'key' }
        })
        return this._onOffer(rpc, data)
      },
      lookup: (data = {}) => {
        validate(data, {
          id: { type: 'key' },
          topic: { type: 'key' }
        })
        return this._onLookup(rpc, data)
      }
    })
  }

  /**
   * @private
   */
  [kDefineEvents] (rpc) {
    rpc.on('candidates', async (data = {}) => {
      try {
        validate(data, {
          id: { type: 'key' },
          remoteId: { type: 'remoteId' },
          topic: { type: 'key' },
          sessionId: { type: 'key' }
        })
        await this._onCandidates(rpc, data)
      } catch (err) {
        log('candidates error', err)
      }
    })
  }
}

module.exports = SocketSignalServer
module.exports.symbols = {
  kDefineActions,
  kDefineEvents
}
