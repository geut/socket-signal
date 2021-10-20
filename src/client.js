import crypto from 'crypto'

import assert from 'nanocustomassert'
import { promise as fastq } from 'fastq'
import { NanomessageRPC, useSocket } from 'nanomessage-rpc'
import { NanoresourcePromise } from 'nanoresource-promise/emittery'

import { Peer } from './peer.js'

const kOutQueue = Symbol('socketsignal.outqueue')
const kInQueue = Symbol('socketsignal.inqueue')
const kPeers = Symbol('socketsignal.peers')
const kDefineActions = Symbol('socketsignal.defineactions')
const kDefineEvents = Symbol('socketsignal.defineevents')
const kAddPeer = Symbol('socketsignal.addpeer')
const kCreatePeer = Symbol('socketsignal.createpeer')
const kOnSignal = Symbol('socketsignal.onsignal')
const kRequestTimeout = Symbol('socketsignal.requesttimeout')

async function worker (peer) {
  await this.open()
  await this.emit('peer-connecting', { peer })
  await peer.open()
}

export class SocketSignalClient extends NanoresourcePromise {
  /**
   * @constructor
   * @param {DuplexStream|NanomessageRPC} socket
   * @param {Object} opts
   * @param {Buffer} opts.id Id of 32 bytes
   * @param {number} opts.requestTimeout How long to wait for peer requests
   * @param {({ incoming: number, outgoing: number }|number)} [opts.concurrency] How many outgoing/incoming connections in concurrent can handle
   * @param {Object} opts.metadata Metadata to share across network
   * @param {Object} opts.simplePeer SimplePeer options
   */
  constructor (socket, opts = {}) {
    super()

    const {
      id = crypto.randomBytes(32),
      requestTimeout = 15 * 1000,
      concurrency = 1,
      simplePeer = {},
      metadata = {}
    } = opts

    assert(!metadata || typeof metadata === 'object', 'metadata must be an object')

    this.socket = socket
    this.rpc = new NanomessageRPC({ timeout: requestTimeout, ...useSocket(socket) })
    this.id = id
    this.metadata = metadata
    this.simplePeer = simplePeer
    this[kRequestTimeout] = requestTimeout

    this[kPeers] = new Map()
    this[kOutQueue] = fastq(this, worker, 1)
    this[kInQueue] = fastq(this, worker, 1)
    this.setConcurrency(concurrency)

    // rpc
    this[kDefineActions]()
    this[kDefineEvents]()
  }

  /**
   * Peers
   *
   * @type {Array<Peer>}
   */
  get peers () {
    return Array.from(this[kPeers].values())
  }

  /**
   * Peers connected
   *
   * @type {Array<Peer>}
   */
  get peersConnected () {
    return this.peers.filter(p => p.connected)
  }

  /**
   * Peers incoming and connecting
   *
   * @type {Array<Peer>}
   */
  get peersConnecting () {
    return this.peers.filter(p => !p.connected)
  }

  /**
   * @readonly
   * @type {number}
   */
  get requestTimeout () {
    return this[kRequestTimeout]
  }

  /**
   * @readonly
   * @type {Object}
   */
  get concurrency () {
    return {
      incoming: this[kInQueue].concurrency,
      outgoing: this[kOutQueue].concurrency
    }
  }

  /**
   * @param {number} timeout
   * @returns {Nanomessage}
   */
  setRequestTimeout (timeout) {
    this.rpc.setRequestsTimeout(timeout)
    this[kRequestTimeout] = timeout
    return this
  }

  /**
   * @param {({ incoming: number, outgoing: number }|number)} value
   * @returns {Nanomessage}
   */
  setConcurrency (value) {
    if (typeof value === 'number') {
      this[kInQueue].concurrency = value
      this[kOutQueue].concurrency = value
    } else {
      this[kInQueue].concurrency = value.incoming || this[kInQueue].concurrency
      this[kOutQueue].concurrency = value.outgoing || this[kOutQueue].concurrency
    }
    return this
  }

  /**
   * Get peers by the topic
   *
   * @param {Buffer} topic
   * @returns {Array<Peer>}
   */
  getPeersByTopic (topic) {
    assert(Buffer.isBuffer(topic), 'topic is required')

    return this.peers.filter(peer => peer.topic.equals(topic))
  }

  /**
   * Join to the network by a topic
   *
   * @param {Buffer} topic
   * @returns {Promise<Array<Peer>>}
   */
  async join (topic) {
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic must be a Buffer of 32 bytes')

    await this.open()
    const peers = await this.rpc.call('socket-signal-join', this._buildMessage({ topic }))
    await this.emit('join', { topic, peers })
    return peers
  }

  /**
   * Leave a topic from the network
   *
   * IMPORTANT: This will not close the current peers for that topic
   * you should call closeConnectionsByTopic(topic)
   *
   * @param {Buffer} topic
   * @returns {Promise}
   */
  async leave (topic) {
    assert(!topic || (Buffer.isBuffer(topic) && topic.length === 32), 'topic must be a Buffer of 32 bytes')

    await this.open()
    await this.rpc.call('socket-signal-leave', this._buildMessage({ topic }))
    await this.emit('leave', { topic })
  }

  /**
   * Calls a new lookup from the network
   *
   * @param {Buffer} topic
   * @returns {Promise<Array<Peer>>}
   */
  async lookup (topic) {
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic must be a Buffer of 32 bytes')

    await this.open()
    const peers = await this.rpc.call('socket-signal-lookup', this._buildMessage({ topic }))
    await this.emit('lookup', { topic, peers })
    return peers
  }

  /**
   * Connects to a peer by their id and topic
   *
   * IMPORTANT: This will not returns a connected peer
   * you should wait for the connection by peer.ready()
   *
   * @param {Buffer} topic
   * @param {Buffer} peerId
   * @param {(Object|undefined)} opts
   * @param {Object} opts.metadata
   * @param {Object} opts.simplePeer
   * @returns {Peer}
   */
  connect (topic, peerId, opts = {}) {
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic must be a Buffer of 32 bytes')
    assert(Buffer.isBuffer(peerId) && peerId.length === 32, 'peerId must be a Buffer of 32 bytes')

    const { metadata, simplePeer = {} } = opts

    const peer = this[kCreatePeer]({ initiator: true, sessionId: crypto.randomBytes(32), id: peerId, topic, metadata, simplePeer })

    this[kAddPeer](peer)

    return peer
  }

  /**
   * Send a request connect to establish the connection starting from the remote side
   * @param {*} topic
   * @param {*} peerId
   * @param {*} opts
   */
  remoteConnect (topic, peerId, opts = {}) {
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic must be a Buffer of 32 bytes')
    assert(Buffer.isBuffer(peerId) && peerId.length === 32, 'peerId must be a Buffer of 32 bytes')

    const { metadata, simplePeer = {} } = opts

    const peer = this[kCreatePeer]({ initiator: false, sessionId: crypto.randomBytes(32), id: peerId, topic, metadata, simplePeer })

    const unsubscribe = peer.on('open', async () => {
      unsubscribe()

      const payload = this._buildMessage({
        sessionId: peer.sessionId,
        remoteId: peer.id,
        topic: peer.topic,
        metadata: peer.metadata
      })

      await this.rpc.call('socket-signal-remote-connect', payload)
    })

    peer.once('close').finally(() => unsubscribe())

    this[kAddPeer](peer)

    return peer
  }

  /**
   * Async handler for incoming peers, peers that you don't get it from .connect(id, topic)
   *
   * This is the right place to define rules to accept or reject connections.
   *
   * @param {(peer: Peer) => (Promise|Error)} handler
   */
  onIncomingPeer (handler) {
    this._onIncomingPeer = handler
    return this
  }

  /**
   * Async handler for incoming offer.
   *
   * @param {(data: { id, topic, metadata }) => (Promise|Error)} handler
   */
  onOffer (handler) {
    this._onOffer = handler
    return this
  }

  /**
   * Async handler for incoming answer.
   *
   * @param {(data: { id, topic, metadata }) => (Promise|Error)} handler
   */
  onAnswer (handler) {
    this._onAnswer = handler
    return this
  }

  onRemoteConnect (handler) {
    this._onRemoteConnect = handler
  }

  /**
   * Close connections by topic
   *
   * @param {Buffer} topic
   * @returns {Promise}
   */
  closeConnectionsByTopic (topic) {
    return Promise.all(this.getPeersByTopic(topic).map(peer => new Promise(resolve => peer.close(() => resolve()))))
  }

  /**
   * @abstract
   */
  async _onIncomingPeer () {}

  /**
   * @abstract
   */
  async _onOffer (data) {}

  /**
   * @abstract
   */
  async _onAnswer (data) {}

  async _onRemoteConnect (data) {}

  async _open () {
    await this.rpc.open()
  }

  async _close () {
    this[kOutQueue].kill()
    this[kInQueue].kill()
    await this.rpc.close()
    await Promise.all(this.peers.map(peer => new Promise(resolve => peer.close(() => resolve()))))
  }

  _buildMessage (data) {
    const { metadata = {}, ...msg } = data
    return { ...msg, id: this.id, metadata: Object.assign({}, this.metadata, metadata) }
  }

  /**
   * @private
   */
  [kDefineActions] () {
    this.rpc.actions({
      offer: async (message) => {
        const result = await this._onOffer(message)

        assert(!result || typeof result === 'object')

        let peer = this.getPeersByTopic(message.topic).find(peer => peer.sessionId.equals(message.sessionId))
        if (!peer) {
          peer = this[kCreatePeer]({
            initiator: false,
            sessionId: message.sessionId,
            id: message.id,
            topic: message.topic,
            metadata: result && result.metadata ? result.metadata : {},
            simplePeer: result && result.simplePeer
          })

          this[kAddPeer](peer)
        }

        if (message.metadata) {
          await peer._setRemoteMetadata(message.metadata)
        }

        peer._setOffer(message.data)

        return peer._waitForAnswer()
      },
      /**
       * @returns {Peer|Error}
       */
      remoteConnect: async (message) => {
        const opts = (await this._onRemoteConnect({
          initiator: true,
          sessionId: message.sessionId,
          id: message.id,
          topic: message.topic,
          metadata: message.metadata
        })) || {}

        const { metadata, simplePeer = {} } = opts

        const peer = this[kCreatePeer]({ initiator: true, sessionId: message.sessionId, id: message.id, topic: message.topic, metadata, simplePeer })
        await peer._setRemoteMetadata(message.metadata) // private
        this[kAddPeer](peer)
      }
    })
  }

  /**
   * @private
   */
  [kDefineEvents] () {
    this.rpc.on('signal', (message) => {
      const { sessionId, data = [] } = message
      const peer = this[kPeers].get(sessionId.toString('hex'))
      if (!peer || peer.destroyed) return
      data.forEach(signal => peer.stream.signal(signal))
    })
  }

  /**
   * @private
   */
  [kAddPeer] (peer) {
    const sessionId = peer.sessionId.toString('hex')

    this[kPeers].set(sessionId, peer)
    peer.waitForClose()
      .catch(error => {
        this.emit('peer-error', { error, peer })
      }).finally(() => {
        this[kPeers].delete(sessionId)
      })

    this[peer.initiator ? kOutQueue : kInQueue].push(peer).then(() => {
      if (this.closing || this.closed) return process.nextTick(() => peer.destroy())
      return this.emit('peer-connected', { peer })
    }).catch((err) => {
      process.nextTick(() => peer.destroy(err))
    })

    // peer queue
    this.emit('peer-queue', { peer })
  }

  /**
   * @private
   */
  [kCreatePeer] (opts) {
    opts = Object.assign({}, opts, {
      onSignal: (peer, batch) => this[kOnSignal](peer, batch),
      simplePeer: Object.assign({}, this.simplePeer, opts.simplePeer),
      timeout: this[kRequestTimeout]
    })

    let peer
    if (typeof this.simplePeer === 'function') {
      peer = this.simplePeer(Peer, opts)
    }

    peer = new Peer(opts)

    return peer
  }

  /**
   * @private
   */
  async [kOnSignal] (peer, batch) {
    const payload = () => this._buildMessage({
      remoteId: peer.id,
      topic: peer.topic,
      sessionId: peer.sessionId,
      data: batch,
      metadata: peer.metadata
    })

    if (!peer.connected) {
      const type = batch[0].type

      if (type === 'offer') {
        const response = await this.rpc.call('socket-signal-offer', payload())
        await this._onAnswer(response)
        response.data.forEach(signal => peer.stream.signal(signal))
        await peer._setRemoteMetadata(response.metadata)
        return
      }

      if (type === 'answer') {
        await this._onIncomingPeer(peer)
        return peer._setAnswer(payload())
      }
    }

    await this.rpc.emit('socket-signal-onsignal', payload())
  }
}
