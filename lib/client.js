const crypto = require('crypto')

const assert = require('nanocustomassert')
const { default: PQueue } = require('p-queue')
const pEvent = require('p-event')
const nanomessagerpc = require('nanomessage-rpc')

const { NanoresourcePromise } = require('nanoresource-promise/emitter')
const Peer = require('./peer')
const { ERR_PEER_NOT_FOUND } = require('./errors')

const kConnectionsQueue = Symbol('socketsignal.connectionsqueue')
const kPeers = Symbol('socketsignal.peers')
const kDefineActions = Symbol('socketsignal.defineactions')
const kDefineEvents = Symbol('socketsignal.defineevents')
const kOnOffer = Symbol('socketsignal.onoffer')
const kIterateSignal = Symbol('socketsignal.iteratesignal')
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
      queueConcurrency = 1,
      metadata,
      simplePeer = {},
      signalMediaStream = true
    } = opts

    assert(!metadata || typeof metadata === 'object', 'metadata must be an object')

    this.socket = socket
    this.rpc = nanomessagerpc(socket, { timeout: requestTimeout })
    this.id = id
    this.metadata = metadata
    this.simplePeer = simplePeer
    this.signalMediaStream = signalMediaStream

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
   * you should wait for the connection by peer.waitForConnection()
   *
   * @param {Buffer} id
   * @param {Buffer} topic
   * @param {(Object|undefined)} metadata
   * @returns {Peer}
   */
  connect (id, topic, metadata) {
    assert(Buffer.isBuffer(id) && id.length === 32, 'id must be a Buffer of 32 bytes')
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic must be a Buffer of 32 bytes')

    const peer = this[kCreatePeer]({ initiator: true, sessionId: crypto.randomBytes(32), id, topic, localMetadata: metadata })

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
   * Close connections by topic
   *
   * @param {Buffer} topic
   * @returns {Promise}
   */
  closeConnectionsByTopic (topic) {
    return Promise.all(this.getPeersByTopic(topic).map(peer => new Promise(resolve => peer.close(() => resolve()))))
  }

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
    const { localMetadata } = data
    let metadata = this.metadata
    if (localMetadata || metadata) {
      metadata = { ...(metadata || {}), ...(localMetadata || {}) }
    }
    return { ...data, id: this.id, metadata }
  }

  /**
   * @abstract
   */
  _onIncomingPeer () {}

  _handleMediaStream (peer) {
    let cache = []
    let running = 0
    peer.on('signal', data => {
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
            if (running === 0 && cache.length > 0) {
              this.rpc.emit('signal', this._buildMessage({
                remoteId: peer.id,
                topic: peer.topic,
                sessionId: peer.sessionId,
                signal: cache,
                localMetadata: peer.localMetadata,
                mediaStream: true
              })).catch(() => {})
              cache = []
            }
          })
      } else {
        if (running) {
          cache.push(data)
          return
        }

        this.rpc.emit('signal', this._buildMessage({
          remoteId: peer.id,
          topic: peer.topic,
          sessionId: peer.sessionId,
          signal: [data],
          localMetadata: peer.localMetadata,
          mediaStream: true
        })).catch(() => {})
      }
    })
  }

  /**
   * @private
   */
  [kDefineActions] () {
    this.rpc.actions({
      offer: (data) => {
        if (data.mediaStream) {
          const peer = this[kPeers].get(data.sessionId.toString('hex'))

          if (!peer) {
            throw new ERR_PEER_NOT_FOUND(peer.id.toString('hex'))
          }
          peer.signal(data.offer)
          return
        }

        const peer = this[kCreatePeer]({
          initiator: false,
          sessionId: data.sessionId,
          id: data.id,
          topic: data.topic,
          metadata: data.metadata
        })

        this[kAddPeer](peer, data.offer)

        return peer._waitForAnswer()
      }
    })
  }

  /**
   * @private
   */
  [kDefineEvents] () {
    this.rpc.on('signal', (data) => {
      try {
        const peer = this[kPeers].get(data.sessionId.toString('hex'))
        if (!peer) {
          return
        }

        // signal needs to be an array of signal objects
        data.signal.forEach(signal => peer.signal(signal))
      } catch (err) {
        // ignore
      }
    })
  }

  /**
   * @private
   */
  [kAddPeer] (peer, offer) {
    const sessionId = peer.sessionId.toString('hex')

    const iterator = pEvent.iterator(peer, 'signal', {
      resolutionEvents: ['connect', 'close']
    })

    this[kPeers].set(sessionId, peer)
    peer.once('close', () => {
      this[kPeers].delete(sessionId)
    })

    const job = async () => {
      await this.open()

      if (peer.destroyed) return

      // the queue job is processing this peer connection
      this.emit('peer-connecting', peer)
      return this[kIterateSignal](iterator, peer, offer)
    }

    this[kConnectionsQueue]
      .add(job)
      .then(() => {
        if (peer.destroyed) return
        peer.on('error', err => this.emit('peer-error', err, peer))
        if (this.signalMediaStream) this._handleMediaStream(peer)
        process.nextTick(() => {
          if (peer.destroyed) return
          peer.emit('safe-connected')
          this.emit('peer-connected', peer)
        })
      })
      .catch(err => {
        process.nextTick(() => {
          if (!peer.destroyed) peer.destroy(err)
          this.emit('peer-error', err, peer)
        })
      })

    // peer queue
    this.emit('peer-queue', peer)
  }

  /**
   * @private
   */
  async [kIterateSignal] (iterator, peer, offer) {
    if (offer) {
      peer.signal(offer)
    }

    for await (const signal of iterator) {
      if (signal.type === 'offer') {
        const response = await this.rpc.call('offer', this._buildMessage({
          remoteId: peer.id,
          topic: peer.topic,
          sessionId: peer.sessionId,
          offer: signal,
          localMetadata: peer.localMetadata
        }))
        peer.signal(response.answer)
        // we store the metadata of the remote peer
        peer.metadata = response.metadata
        continue
      } else if (signal.type === 'answer') {
        await this._onIncomingPeer(peer)
        peer._sendAnswer(this._buildMessage({
          remoteId: peer.id,
          topic: peer.topic,
          sessionId: peer.sessionId,
          answer: signal,
          localMetadata: peer.localMetadata
        }))
        continue
      }

      await this.rpc.emit('signal', this._buildMessage({
        remoteId: peer.id,
        topic: peer.topic,
        sessionId: peer.sessionId,
        signal: [signal],
        localMetadata: peer.localMetadata
      }))
    }
  }

  [kCreatePeer] (args) {
    if (typeof this.simplePeer === 'function') {
      return this.simplePeer(args, Peer)
    }

    return new Peer(args, this.simplePeer)
  }
}

module.exports = SocketSignalClient
module.exports.symbols = {
  kConnectionsQueue,
  kPeers,
  kDefineActions,
  kDefineEvents,
  kOnOffer,
  kIterateSignal,
  kAddPeer
}
