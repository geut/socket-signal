const SimplePeer = require('simple-peer')
const assert = require('nanocustomassert')
const pEvent = require('p-event')
const eos = require('end-of-stream')

const kInit = Symbol('peer.init')
const kAdded = Symbol('peer.added')
const kAddedHandler = Symbol('peer.addedhandler')
const kMetadata = Symbol('peer.metadata')
const kLocalMetadata = Symbol('peer.localmetadata')
const kAnswered = Symbol('peer.answered')
const kInternalData = Symbol('peer.kinternaldata')
const kSendInternalData = Symbol('peer.ksendinternaldata')

const INTERNAL_DATA = Buffer.from([0])
const EXTERNAL_DATA = Buffer.from([1])

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

  addStream (stream) {
    this.waitForConnection()
      .then(() => super.addStream(stream))
      .catch(err => console.error('Error on addStream', err))
  }

  /**
   * Wait until the peer gets a safe-connection and was added to the client list
   */
  async waitForConnection () {
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

  /**
   * Send text/binary data to the remote peer.
   * @override
   * @param {ArrayBufferView|ArrayBuffer|Buffer|string|Blob} chunk
   */
  send (chunk) {
    if (chunk instanceof ArrayBuffer) {
      chunk = Buffer.from(chunk)
    }

    if (typeof chunk === 'string' || !Buffer.isBuffer(chunk)) {
      this._channel.send(chunk)
      return
    }

    this._channel.send(Buffer.concat([EXTERNAL_DATA, chunk], chunk.length + 1))
  }

  /**
   * @override
   * @param {*} event
   */
  _onChannelMessage (event) {
    if (this.destroyed) return
    let { data } = event

    if (typeof data === 'string' || !(data instanceof ArrayBuffer)) {
      this.push(data)
      return
    }

    data = Buffer.from(data)
    const dataType = data.slice(0, 1)
    data = data.slice(1)

    if (dataType.equals(EXTERNAL_DATA)) {
      this.push(data)
      return
    }

    this.emit(kInternalData, data)
  }

  [kInit] () {
    this.once(kAdded, this[kAddedHandler].bind(this))
    this.on(kInternalData, data => {
      data = JSON.parse(data)
      if (data.type === 'signal') {
        this.signal(data.data)
      }
    })
    this.once('connect', () => {
      this.emit('safe-connect')

      this.on('signal', data => {
        this[kSendInternalData](Buffer.from(JSON.stringify({ type: 'signal', data })))
      })
    })
  }

  [kAddedHandler] () {
    this[kAdded] = true
  }

  [kSendInternalData] (chunk) {
    this._channel.send(Buffer.concat([INTERNAL_DATA, chunk], chunk.length + 1))
  }
}
