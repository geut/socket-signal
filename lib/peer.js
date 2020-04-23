const SimplePeer = require('simple-peer')
const assert = require('nanocustomassert')
const pEvent = require('p-event')
const eos = require('end-of-stream')
const varint = require('varint')

const kInit = Symbol('peer.init')
const kMetadata = Symbol('peer.metadata')
const kLocalMetadata = Symbol('peer.localmetadata')
const kOnAnswered = Symbol('peer.onanswered')
const kOnInternalData = Symbol('peer.oninternaldata')
const kSend = Symbol('peer.send')
const kInternalDataCache = Symbol('peer.internaldatacache')
const kInternalDataHandler = Symbol('peer.internaldatahandler')

const DEFAULT_DATA = 0
const INTERNAL_DATA = 1
const EXTENSION_DATA = 2

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
    this.safeConnected = false

    this[kMetadata] = metadata
    this[kLocalMetadata] = localMetadata
    this[kInternalDataCache] = []
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
   * Wait until the peer gets a safe-connection
   */
  async waitForConnection () {
    if (this.safeConnected) return
    return pEvent(this, 'safe-connected')
  }

  waitForClose () {
    return new Promise((resolve) => {
      if (this.destroyed) return true
      eos(this, () => resolve())
    })
  }

  sendExtensionData (chunk) {
    assert(Buffer.isBuffer(chunk))
    this[kSend](EXTENSION_DATA, chunk)
  }

  close () {
    process.nextTick(() => this.destroy())
  }

  _waitForAnswer () {
    return pEvent(this, kOnAnswered)
  }

  _sendAnswer (answer) {
    this.emit(kOnAnswered, answer)
  }

  _safeConnected () {
    this.emit('safe-connected')
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

    if (!Buffer.isBuffer(chunk)) {
      this._channel.send(chunk)
      return
    }

    this[kSend](DEFAULT_DATA, chunk)
  }

  /**
   * @override
   * @param {*} event
   */
  _onChannelMessage (event) {
    if (this.destroyed) return
    let { data } = event

    if (!(data instanceof ArrayBuffer)) {
      this.push(data)
      return
    }

    data = Buffer.from(data)

    try {
      // get type
      const type = varint.decode(data)
      data = data.slice(varint.decode.bytes)

      switch (type) {
        case DEFAULT_DATA:
          this.push(data)
          break
        case INTERNAL_DATA:
          this.emit(kOnInternalData, data)
          break
        case EXTENSION_DATA:
          this.emit('extension-data', data)
      }
    } catch (err) {
      this.push(data)
    }
  }

  [kInit] () {
    this.on(kOnInternalData, data => {
      if (this.safeConnected) {
        this[kInternalDataHandler](data)
        return
      }

      this[kInternalDataCache].push(data)
    })

    this.once('close', () => {
      this.safeConnected = false
    })

    this.once('safe-connected', () => {
      this.safeConnected = true

      this.on('signal', data => {
        this[kSend](INTERNAL_DATA, Buffer.from(JSON.stringify({ type: 'signal', data })))
      })

      if (this[kInternalDataCache].length > 0) {
        this[kInternalDataCache].forEach(data => this[kInternalDataHandler](data))
        this[kInternalDataCache] = []
      }
    })
  }

  [kSend] (type, chunk) {
    if (this.destroyed) return
    const header = Buffer.from(varint.encode(type))
    this._channel.send(Buffer.concat([header, chunk], header.length + chunk.length))
  }

  [kInternalDataHandler] (data) {
    data = JSON.parse(data)
    if (data.type === 'signal') {
      this.signal(data.data)
    }
  }
}
