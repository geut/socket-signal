const { NanoresourcePromise } = require('nanoresource-promise/emitter')
const SimplePeer = require('simple-peer')
const assert = require('nanocustomassert')
const pEvent = require('p-event')
const eos = require('end-of-stream')
const pLimit = require('p-limit')

const { ERR_CONNECTION_CLOSED } = require('./errors')

const kMetadata = Symbol('peer.metadata')
const kLocalMetadata = Symbol('peer.localmetadata')
const kOnSignal = Symbol('peer.onsignal')
const kSubscribeMediaStream = Symbol('peer.subscribemediastream')
const kUnsubscribeMediaStream = Symbol('peer.unsubscribemediastream')
const kOffer = Symbol('peer.offer')

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
    this.stream = null
    this.destroyError = null

    this[kOnSignal] = onSignal
    this[kMetadata] = metadata
    this[kLocalMetadata] = localMetadata
    this[kSubscribeMediaStream] = subscribeMediaStream
    this[kUnsubscribeMediaStream] = null
    this[kOffer] = null
    this.once('error', err => {
      this.destroyError = err
    })
  }

  get connected () {
    return this.stream && this.stream.connected
  }

  get destroyed () {
    return this.stream && this.stream.destroyed
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

  async ready () {
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
      .then(() => {
        console.log('agrega')
        this.stream.addStream(stream)
      })
      .catch(err => process.nextTick(() => this.emit('stream-error', err)))
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
    this.stream.destroy(err)
  }

  open (offer) {
    if (offer) this[kOffer] = offer
    return super.open()
  }

  async _open () {
    const { streams = [], ...opts } = this.simplePeerOptions
    this.stream = new SimplePeer({ ...opts, initiator: this.initiator })
    streams.forEach(stream => this.addStream(stream))

    const ready = this.ready()

    let cache = []
    const limit = pLimit(1)
    const clean = () => this.stream.removeListener('signal', onSignal)
    const onSignal = (signal) => {
      cache.push(signal)
      limit(async () => {
        limit.clearQueue()
        if (cache.length === 0 || this.destroyed || this.connected) return

        let prev
        do {
          prev = cache.length
          await new Promise(resolve => setTimeout(resolve, 1))
        } while (prev < cache.length && cache.length < 4)

        const tmp = cache
        cache = []
        const signal = tmp[0]
        return this[kOnSignal](this, signal.type, tmp)
      }).catch(err => {
        limit.clearQueue()
        clean()
        process.nextTick(() => this.destroy(err))
      }).finally(() => {
        if (this.destroyed || this.connected) {
          limit.clearQueue()
          clean()
        }
      })
    }

    this._defineEvents(clean)
    this.stream.on('signal', onSignal)

    if (!this.initiator && this[kOffer]) {
      this[kOffer].forEach(signal => this.stream.signal(signal))
    }

    return ready
  }

  _close () {
    if (this.destroyed) return
    process.nextTick(() => this.stream.destroy())
    return new Promise(resolve => eos(this.stream, () => resolve()))
  }

  _defineEvents (removeOnSignal) {
    const onStream = (...args) => this.emit('stream', ...args)
    const onSignal = (signal) => this.emit('signal', signal)
    const onError = err => this.emit('error', err)
    const onConnect = () => {
      removeOnSignal()
      this.emit('connect')
    }
    const onClose = () => {
      this.stream.removeListener('stream', onStream)
      this.stream.removeListener('stream', onSignal)
      this.stream.removeListener('error', onError)
      removeOnSignal()
      this.close().catch(() => {})
      this.emit('close')
    }

    this.stream.on('stream', onStream)
    this.stream.on('signal', onSignal)
    this.stream.once('error', onError)
    this.stream.once('connect', onConnect)
    this.stream.once('close', onClose)
  }
}
