/**
 * @typedef {object} Data
 * @property {Buffer} id
 * @property {Buffer} topic
 * @property {Object} metadata
*/

/**
 * @typedef {object} SignalData
 * @extends Data
 * @property {Buffer} remoteId
 * @property {Buffer} sessionId
 * @property {Array<Object>} data
*/

import debug from 'debug'
import { NanomessageRPC, useSocket } from 'nanomessage-rpc'

import { NanoresourcePromise } from 'nanoresource-promise/emitter'

import randomBytes from './random-bytes.js'

const log = debug('socketsignal:server')

const kDefineActions = Symbol('socketsignal.defineactions')
const kDefineEvents = Symbol('socketsignal.defineevents')

export class SocketSignalServer extends NanoresourcePromise {
  constructor (opts = {}) {
    super()

    const { onConnect, onDisconnect, onJoin, onLeave, onLookup, onOffer, onSignal, requestTimeout = 10 * 1000, ...rpcOpts } = opts

    if (onConnect) this._onConnect = onConnect
    if (onDisconnect) this._onDisconnect = onDisconnect
    if (onJoin) this._onJoin = onJoin
    if (onLeave) this._onLeave = onLeave
    if (onLookup) this._onLookup = onLookup
    if (onOffer) this._onOffer = onOffer
    if (onSignal) this._onSignal = onSignal

    this._requestTimeout = requestTimeout
    this._rpcOpts = rpcOpts

    this.connections = new Set()
  }

  /**
   * Adds a duplex stream socket
   *
   * @param {DuplexStream|NanomessageRPC} socket
   * @returns {NanomessageRPC}
   */
  async addSocket (socket) {
    await this.open()

    const rpc = new NanomessageRPC({ timeout: this._requestTimeout, ...this._rpcOpts, ...useSocket(socket) })
    rpc.socket = socket
    rpc.id = rpc.id || randomBytes(32)

    this[kDefineActions](rpc)
    this[kDefineEvents](rpc)

    const deleteConnection = () => {
      if (this.connections.delete(rpc)) {
        log('connection-deleted', rpc.id.toString('hex'))
        return this._onDisconnect(rpc)
      }
    }

    rpc.ee.on('closed', deleteConnection)

    rpc.ee.on('error', err => this.emit('connection-error', err, rpc))

    await rpc.open()

    let error
    try {
      log('connection-added', rpc.id.toString('hex'))
      await this._onConnect(rpc)
      this.connections.add(rpc)
    } catch (err) {
      error = err
    }

    if (error) {
      await rpc.close().catch(() => {})
      await deleteConnection().catch(() => {})
      this.emit('connection-error', error, rpc)
      throw error
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
   * @param {SignalData} data
   * @returns {Promise<SignalData>}
   */
  async _onOffer () {}

  /**
   * Action remoteConnect
   *
   * @abstract
   * @param {NanomessageRPC} rpc
   * @param {SignalData} data
   * @returns {Promise<SignalData>}
   */
  async _onRemoteConnect () {}

  /**
   * Event signal
   *
   * @abstract
   * @param {NanomessageRPC} rpc
   * @param {SignalData} data
   */
  async _onSignal () {}

  async _onPreRequest () {}

  /**
   * @private
   */
  [kDefineActions] (rpc) {
    rpc.actions({
      'socket-signal-join': async (data = {}) => {
        await this._onPreRequest(rpc, data, 'join')
        return this._onJoin(rpc, data)
      },
      'socket-signal-leave': async (data = {}) => {
        await this._onPreRequest(rpc, data, 'leave')
        return this._onLeave(rpc, data)
      },
      'socket-signal-offer': async (data = {}) => {
        await this._onPreRequest(rpc, data, 'offer')
        return this._onOffer(rpc, data)
      },
      'socket-signal-lookup': async (data = {}) => {
        await this._onPreRequest(rpc, data, 'lookup')
        return this._onLookup(rpc, data)
      },
      'socket-signal-remote-connect': async (data = {}) => {
        await this._onPreRequest(rpc, data, 'remoteConnect')
        return this._onRemoteConnect(rpc, data)
      }
    })
  }

  /**
   * @private
   */
  [kDefineEvents] (rpc) {
    rpc.on('socket-signal-onsignal', async (data = {}) => {
      try {
        await this._onPreRequest(rpc, data, 'signal')
        await this._onSignal(rpc, data)
      } catch (err) {
        log('signal error', err)
      }
    })
  }
}
