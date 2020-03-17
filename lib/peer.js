const SimplePeer = require('simple-peer')
const assert = require('nanocustomassert')
const pEvent = require('p-event')
const eos = require('end-of-stream')

const kInit = Symbol('peer.init')
const kCacheEvents = Symbol('peer.cacheevents')
const kStreamHandler = Symbol('peer.streamhandler')
const kTrackHandler = Symbol('peer.trackhandler')
const kAdded = Symbol('peer.added')
const kAddedHandler = Symbol('peer.addedhandler')
const kMetadata = Symbol('peer.metadata')
const kLocalMetadata = Symbol('peer.localmetadata')
const kAnswered = Symbol('peer.answered')

module.exports = class Peer extends SimplePeer {
  constructor (data, opts = {}) {
    const { initiator, sessionId, id, topic, metadata, localMetadata } = data

    assert(initiator !== undefined, 'initiator is required')
    assert(Buffer.isBuffer(sessionId) && sessionId.length === 32, 'sessionId is required and must be a buffer of 32')
    assert(Buffer.isBuffer(id) && id.length === 32, 'id is required and must be a buffer of 32')
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic is required and must be a buffer of 32')
    assert(!metadata || typeof metadata === 'object', 'metadata must be an object')
    assert(!localMetadata || typeof localMetadata === 'object', 'localMetadata must be an object')

    super({ ...opts, initiator })

    this.sessionId = sessionId
    this.id = id
    this.topic = topic

    this[kMetadata] = metadata
    this[kLocalMetadata] = localMetadata
    this[kAdded] = false
    this[kCacheEvents] = []
    this[kStreamHandler] = this[kStreamHandler].bind(this)
    this[kTrackHandler] = this[kTrackHandler].bind(this)
    this[kAddedHandler] = this[kAddedHandler].bind(this)
    this[kInit]()
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

  /**
   * Wait until the peer gets a safe-connection and was added to the client list
   */
  waitForConnection () {
    if (this[kAdded]) return
    return pEvent(this, kAdded)
  }

  waitForClose () {
    return new Promise((resolve) => {
      if (this.destroyed) return true
      eos(this, () => resolve())
    })
  }

  close () {
    process.nextTick(() => this.destroy())
  }

  _waitForAnswer () {
    return pEvent(this, kAnswered)
  }

  _sendAnswer (answer) {
    this.emit(kAnswered, answer)
  }

  _peerAdded () {
    this.emit(kAdded)
  }

  [kInit] () {
    this.once(kAdded, this[kAddedHandler].bind(this))
    this.on('stream', this[kStreamHandler])
    this.on('track', this[kTrackHandler])
    this.once('connect', () => {
      process.nextTick(() => {
        this.emit('safe-connect')
        this.emit('connect')
        process.nextTick(() => {
          this[kCacheEvents].forEach(({ name, args }) => {
            this.emit(name, ...args)
          })
        })
      })

      this.removeListener('stream', this[kStreamHandler])
      this.removeListener('track', this[kTrackHandler])
    })
  }

  [kStreamHandler] (stream) {
    this[kCacheEvents].push({ name: 'stream', args: [stream] })
  }

  [kTrackHandler] (track, stream) {
    this[kCacheEvents].push({ name: 'track', args: [track, stream] })
  }

  [kAddedHandler] () {
    this[kAdded] = true
  }
}
