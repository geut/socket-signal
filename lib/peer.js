const SimplePeer = require('simple-peer')
const assert = require('nanocustomassert')
const pEvent = require('p-event')
const eos = require('end-of-stream')

const { ERR_CONNECTION_CLOSED } = require('./errors')

const kMetadata = Symbol('peer.metadata')
const kLocalMetadata = Symbol('peer.localmetadata')
const kOnAnswered = Symbol('peer.onanswered')
const kSubscribeMediaStream = Symbol('peer.subscribemediastream')
const kUnsubscribeMediaStream = Symbol('peer.unsubscribemediastream')

module.exports = class Peer extends SimplePeer {
  constructor (opts = {}) {
    const { initiator, sessionId, id, topic, metadata, localMetadata, subscribeMediaStream, simplePeer = {} } = opts

    assert(initiator !== undefined, 'initiator is required')
    assert(Buffer.isBuffer(sessionId) && sessionId.length === 32, 'sessionId is required and must be a buffer of 32')
    assert(Buffer.isBuffer(id) && id.length === 32, 'id is required and must be a buffer of 32')
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic is required and must be a buffer of 32')
    assert(!metadata || typeof metadata === 'object', 'metadata must be an object')
    assert(!localMetadata || typeof localMetadata === 'object', 'localMetadata must be an object')

    super({ ...simplePeer, initiator })

    this.sessionId = sessionId
    this.id = id
    this.topic = topic

    this.destroyError = null
    this.once('error', err => {
      this.destroyError = err
    })

    this[kMetadata] = metadata
    this[kLocalMetadata] = localMetadata
    this[kSubscribeMediaStream] = subscribeMediaStream
    this[kUnsubscribeMediaStream] = null
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
    return pEvent(this, 'safe-connected', {
      rejectionEvents: ['error', 'close']
    })
  }

  addStream (stream) {
    this.ready()
      .then(() => super.addStream(stream))
      .catch(err => {
        process.nextTick(() => this.emit('stream-error', err))
      })
    return this
  }

  close (cb) {
    if (this.destroyed) return cb()
    process.nextTick(() => this.destroy())
    eos(this, cb)
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

  _answered () {
    return pEvent(this, kOnAnswered, {
      rejectionEvents: ['error', 'close']
    })
  }

  _sendAnswer (answer) {
    this.emit(kOnAnswered, answer)
  }
}
