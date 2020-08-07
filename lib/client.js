const crypto = require('crypto')

const assert = require('nanocustomassert')
const { default: PQueue } = require('p-queue')
const pEvent = require('p-event')
const nanomessagerpc = require('nanomessage-rpc')
const { NanoresourcePromise } = require('nanoresource-promise/emitter')

const Peer = require('./peer')
const CacheSignal = require('./cache-signal')
const { ERR_PEER_NOT_FOUND } = require('./errors')

const kConnectionsQueue = Symbol('socketsignal.connectionsqueue')
const kPeers = Symbol('socketsignal.peers')
const kDefineActions = Symbol('socketsignal.defineactions')
const kDefineEvents = Symbol('socketsignal.defineevents')
const kAddPeer = Symbol('socketsignal.addpeer')
const kCreatePeer = Symbol('socketsignal.createpeer')

class SocketSignalClient extends NanoresourcePromise {
  /**
   * @constructor
   * @param {DuplexStream} socket
   * @param {Object} opts
   * @param {Buffer} opts.id Id of 32 bytes
   * @param {number} opts.requestTimeout How long to wait for peer requests
   * @param {number} opts.queueTimeout How long to wait for a job queue incoming connection
   * @param {number} opts.queueConcurrency How many incoming connections in concurrent can handle
   * @param {Object} opts.metadata Metadata to share across network
   * @param {Object} opts.simplePeer SimplePeer options
   */
  constructor (socket, opts = {}) {
    super()

    const {
      id = crypto.randomBytes(32),
      requestTimeout = 5 * 1000,
      queueTimeout = 10 * 1000,
      queueConcurrency = Infinity,
      simplePeer = {},
      metadata
    } = opts

    assert(!metadata || typeof metadata === 'object', 'metadata must be an object')

    this.socket = socket
    this.rpc = nanomessagerpc({ timeout: requestTimeout, ...nanomessagerpc.useSocket(socket) })
    this.id = id
    this.metadata = metadata
    this.simplePeer = simplePeer

    this[kPeers] = new Map()
    this[kConnectionsQueue] = new PQueue({
      concurrency: queueConcurrency,
      timeout: queueTimeout,
      throwOnTimeout: true
    })

    // rpc
    this[kDefineActions]()
    this[kDefineEvents]()
  }

  /**
   * Peers connected
   *
   * @type {Array<Peer>}
   */
  get peers () {
    return Array.from(this[kPeers].values()).filter(p => p.connected)
  }

  /**
   * Peers incoming and connecting
   *
   * @type {Array<Peer>}
   */
  get peersConnecting () {
    return Array.from(this[kPeers].values()).filter(p => !p.connected)
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
    const peers = await this.rpc.call('join', this._buildMessage({ topic }))
    this.emit('join', topic, peers)
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
    await this.rpc.call('leave', this._buildMessage({ topic }))
    this.emit('leave', topic)
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
    const peers = await this.rpc.call('lookup', this._buildMessage({ topic }))
    this.emit('lookup', topic, peers)
    return peers
  }

  /**
   * Connects to a peer by their id and topic
   *
   * IMPORTANT: This will not returns a connected peer
   * you should wait for the connection by peer.ready()
   *
   * @param {Buffer} id
   * @param {Buffer} topic
   * @param {(Object|undefined)} opts
   * @param {Object} opts.metadata
   * @param {Object} opts.simplePeer
   * @returns {Peer}
   */
  connect (id, topic, opts = {}) {
    assert(Buffer.isBuffer(id) && id.length === 32, 'id must be a Buffer of 32 bytes')
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic must be a Buffer of 32 bytes')

    const { metadata: localMetadata, simplePeer = {} } = opts

    const peer = this[kCreatePeer]({ initiator: true, sessionId: crypto.randomBytes(32), id, topic, localMetadata, simplePeer })

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

  async _open () {
    await this.rpc.open()
  }

  async _close () {
    this[kConnectionsQueue].clear()
    this[kConnectionsQueue].pause()
    await this.rpc.close()
    await Promise.all(this.peers.map(peer => new Promise(resolve => peer.close(() => resolve()))))
  }

  _buildMessage (data) {
    const { localMetadata = {}, ...msg } = data
    let metadata = this.metadata || {}
    if (localMetadata) {
      metadata = { ...metadata, ...localMetadata }
    }
    return { ...msg, id: this.id, metadata }
  }

  _subscribeMediaStream (peer) {
    let running = 0

    const cache = new CacheSignal({ client: this, peer, mediaStream: true })

    const onSignal = data => {
      if (!peer.connected) return

      if (data.type === 'offer') {
        running++

        this.rpc.call('offer', this._buildMessage({
          remoteId: peer.id,
          topic: peer.topic,
          sessionId: peer.sessionId,
          offer: data,
          localMetadata: peer.localMetadata,
          mediaStream: true
        }))
          .catch(() => {})
          .finally(() => {
            running--
          }).then(() => {
            if (running === 0) cache.send()
          })

        return
      }

      cache.push(data)

      if (running) return

      cache.send()
    }

    peer.on('signal', onSignal)

    return () => peer.removeListener('signal', onSignal)
  }

  /**
   * @private
   */
  [kDefineActions] () {
    this.rpc.actions({
      offer: async (message) => {
        if (message.mediaStream) {
          const peer = this[kPeers].get(message.sessionId.toString('hex'))

          if (!peer) {
            throw new ERR_PEER_NOT_FOUND(peer.id.toString('hex'))
          }
          peer.signal(message.data)
          return
        }

        const result = await this._onOffer(message)

        assert(!result || typeof result === 'object')

        const peer = this[kCreatePeer]({
          initiator: false,
          sessionId: message.sessionId,
          id: message.id,
          topic: message.topic,
          metadata: message.metadata,
          localMetadata: result && result.metadata,
          simplePeer: result && result.simplePeer
        })

        this[kAddPeer](peer, message.data)

        return pEvent(peer, 'answer', {
          rejectionEvents: ['error', 'closed']
        })
      }
    })
  }

  [kDefineEvents] () {
    this.rpc.on('signal', (message) => {
      const { sessionId, data = [] } = message
      const peer = this[kPeers].get(sessionId.toString('hex'))
      if (!peer || peer.destroyed) return
      data.forEach(signal => peer.simplePeer.signal(signal))
    })
  }

  /**
   * @private
   */
  [kAddPeer] (peer, data) {
    const sessionId = peer.sessionId.toString('hex')

    this[kPeers].set(sessionId, peer)
    peer.once('close', () => {
      this[kPeers].delete(sessionId)
    })
    peer.once('error', err => {
      this.emit('peer-error', err, peer)
    })

    const job = async () => {
      await this.open()
      this.emit('peer-connecting', peer)
      return peer.open(data)
    }

    this[kConnectionsQueue]
      .add(job)
      .then(() => this.emit('peer-connected', peer))
      .catch(err => process.nextTick(() => peer.destroy(err)))

    // peer queue
    this.emit('peer-queue', peer)
  }

  [kCreatePeer] (opts) {
    opts = Object.assign({}, opts, {
      onSignal: async (peer, type, data) => {
        const payload = () => this._buildMessage({
          remoteId: peer.id,
          topic: peer.topic,
          sessionId: peer.sessionId,
          data,
          localMetadata: peer.localMetadata
        })

        if (type === 'offer') {
          const response = await this.rpc.call('offer', payload())
          await this._onAnswer(response)
          response.data.forEach(signal => peer.simplePeer.signal(signal))
          peer.metadata = response.metadata
          return
        }

        if (type === 'answer') {
          await this._onIncomingPeer(peer)
          return peer.emit('answer', payload())
        }

        await this.rpc.emit('signal', payload())
      },
      subscribeMediaStream: (peer) => this._subscribeMediaStream(peer),
      simplePeer: Object.assign({}, this.simplePeer, opts.simplePeer)
    })

    if (typeof this.simplePeer === 'function') {
      return this.simplePeer(Peer, opts)
    }

    return new Peer(opts)
  }
}

module.exports = SocketSignalClient
