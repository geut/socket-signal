const { NanoresourcePromise } = require('nanoresource-promise/emitter')
const SimplePeer = require('simple-peer')
const assert = require('nanocustomassert')
const pEvent = require('p-event')
const eos = require('end-of-stream')
const debounce = require('lodash.debounce')
const pLimit = require('p-limit')

const { ERR_CONNECTION_CLOSED } = require('./errors')

const kMetadata = Symbol('peer.metadata')
const kLocalMetadata = Symbol('peer.localmetadata')
const kOnSignal = Symbol('peer.onsignal')
const kSubscribeMediaStream = Symbol('peer.subscribemediastream')
const kUnsubscribeMediaStream = Symbol('peer.unsubscribemediastream')
const kOffer = Symbol('offer')

module.exports = class Peer extends NanoresourcePromise {
  constructor (opts = {}) {
    super()

    const { onSignal, initiator, sessionId, id, topic, metadata, localMetadata, subscribeMediaStream, simplePeer = {} } = opts

    assert(onSignal, 'onSignal is required')
    assert(initiator !== undefined, 'initiator is required')
    assert(Buffer.isBuffer(sessionId) && sessionId.length === 32, 'sessionId is required and must be a buffer of 32')
    assert(Buffer.isBuffer(id) && id.length === 32, 'id is required and must be a buffer of 32')
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic is required and must be a buffer of 32')
    assert(!metadata || typeof metadata === 'object', 'metadata must be an object')
    assert(!localMetadata || typeof localMetadata === 'object', 'localMetadata must be an object')

    this.initiator = initiator
    this.sessionId = sessionId
    this.id = id
    this.topic = topic
    this.simplePeerOptions = simplePeer

    // initialized during the open
    this.simplePeer = null
    this.destroyError = null

    this[kOnSignal] = onSignal
    this[kMetadata] = metadata
    this[kLocalMetadata] = localMetadata
    this[kSubscribeMediaStream] = subscribeMediaStream
    this[kUnsubscribeMediaStream] = null
    this[kOffer] = null
  }

  get connected () {
    return this.simplePeer && this.simplePeer.connected
  }

  get destroyed () {
    return this.simplePeer && this.simplePeer.destroyed
  }

  get metadata () {
    return this[kMetadata]
  }

  set metadata (metadata) {
    assert(!metadata || typeof metadata === 'object', 'metadata must be an object')
    this[kMetadata] = metadata
    this.emit('metadata-updated', this[kMetadata])
    return this[kMetadata]
  }

  get localMetadata () {
    return this[kLocalMetadata]
  }

  set localMetadata (metadata) {
    assert(!metadata || typeof metadata === 'object', 'localMetadata must be an object')
    this[kLocalMetadata] = metadata
    this.emit('local-metadata-updated', this[kLocalMetadata])
    return this[kLocalMetadata]
  }

  ready () {
    if (this.connected) return
    if (this.destroyed) {
      if (this.destroyError) throw this.destroyError
      throw new ERR_CONNECTION_CLOSED()
    }
    return pEvent(this, 'connect', {
      rejectionEvents: ['error', 'close']
    })
  }

  addStream (stream) {
    this.ready()
      .then(() => this.simplePeer.addStream(stream))
      .catch(err => {
        process.nextTick(() => this.emit('stream-error', err))
      })
    return this
  }

  subscribeMediaStream () {
    assert(this[kSubscribeMediaStream] && typeof this[kSubscribeMediaStream] === 'function', 'subscribeMediaStream must be a function')
    if (this[kUnsubscribeMediaStream] || !this[kSubscribeMediaStream]) return

    const unsubscribe = this[kSubscribeMediaStream](this)
    assert(unsubscribe && typeof unsubscribe === 'function', 'subscribeMediaStream must return an unsubscribe function')

    this[kUnsubscribeMediaStream] = unsubscribe
    return this
  }

  unsubscribeMediaStream () {
    if (!this[kUnsubscribeMediaStream]) return
    this[kUnsubscribeMediaStream](this)
    this[kUnsubscribeMediaStream] = null
    return this
  }

  destroy (err) {
    this.simplePeer.destroy(err)
  }

  send (data) {
    if (!this.simplePeer) throw new Error('simplePeer not initialized')
    this.simplePeer.send(data)
  }

  open (offer) {
    if (offer) this[kOffer] = offer
    return super.open()
  }

  async _open () {
    this.simplePeer = new SimplePeer({ ...this.simplePeerOptions, initiator: this.initiator })
    this.simplePeer.once('error', err => {
      this.destroyError = err
      this.emit('error', err)
    })
    this.simplePeer.once('connect', () => this.emit('connect'))
    this.simplePeer.once('close', () => {
      this.close().catch(() => {})
      this.emit('close')
    })

    const ready = this.ready()

    let cache = []
    const limit = pLimit(1)
    const clean = () => this.simplePeer.removeListener('signal', onSignal)
    const onSignal = debounce(() => {
      limit(async () => {
        limit.clearQueue()
        if (cache.length === 0) return
        if (this.destroyed || this.connected) return clean()

        const tmp = cache
        cache = []

        const signal = tmp[0]
        return this[kOnSignal](this, signal.type, tmp)
      }).catch(err => {
        limit.clearQueue()
        clean()
        process.nextTick(() => this.destroy(err))
      }).finally(() => {
        limit.clearQueue()
        if (this.destroyed || this.connected) clean()
      })
    }, 1)

    this.simplePeer.on('signal', (signal) => {
      cache.push(signal)
      onSignal()
    })

    if (!this.initiator && this[kOffer]) {
      this[kOffer].forEach(signal => this.simplePeer.signal(signal))
    }

    return ready
  }

  _close () {
    if (this.destroyed) return
    process.nextTick(() => this.simplePeer.destroy())
    return new Promise(resolve => eos(this.simplePeer, () => resolve()))
  }
}
