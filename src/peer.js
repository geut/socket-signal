import { NanoresourcePromise } from 'nanoresource-promise/emittery'
import SimplePeer from 'simple-peer'
import assert from 'nanocustomassert'
import eos from 'end-of-stream'

import { SignalBatch } from './signal-batch.js'
import { ERR_CONNECTION_CLOSED, ERR_SIGNAL_TIMEOUT } from './errors.js'

const kMetadata = Symbol('peer.metadata')
const kRemoteMetadata = Symbol('peer.remotemetadata')
const kOnSignal = Symbol('peer.onsignal')
const kOffer = Symbol('peer.offer')
const kAnswer = Symbol('peer.answer')
const kSignalBatch = Symbol('peer.signalbatch')

export class Peer extends NanoresourcePromise {
  constructor (opts = {}) {
    super()

    const { onSignal, initiator, sessionId, id, topic, metadata = {}, simplePeer = {}, timeout } = opts

    assert(onSignal)
    assert(initiator !== undefined, 'initiator is required')
    assert(Buffer.isBuffer(sessionId) && sessionId.length === 32, 'sessionId is required and must be a buffer of 32')
    assert(Buffer.isBuffer(id) && id.length === 32, 'id is required and must be a buffer of 32')
    assert(Buffer.isBuffer(topic) && topic.length === 32, 'topic must be a buffer of 32')
    assert(typeof metadata === 'object', 'metadata must be an object')

    this.initiator = initiator
    this.sessionId = sessionId
    this.id = id
    this.topic = topic
    this.simplePeerOptions = simplePeer
    this.timeout = timeout

    this.subscribeMediaStream = false
    this.error = null
    this.signals = []

    this[kSignalBatch] = new SignalBatch()
    this[kOnSignal] = onSignal
    this[kOffer] = null
    this[kMetadata] = metadata
    this[kRemoteMetadata] = {}
    this.once('error').catch(err => {
      this.error = err
    })

    this._initializeSimplePeer()
  }

  get connected () {
    return this.stream.connected
  }

  get destroyed () {
    return this.stream.destroyed || this.closed
  }

  get metadata () {
    return this[kMetadata]
  }

  get remoteMetadata () {
    return this[kRemoteMetadata]
  }

  get mediaStreams () {
    return this.stream._remoteStreams
  }

  async setMetadata (metadata) {
    assert(!metadata || typeof metadata === 'object', 'metadata must be an object')
    this[kMetadata] = metadata
    await this.emit('metadata-updated', metadata)
    return this[kMetadata]
  }

  async ready () {
    if (this.connected) return
    if (this.destroyed) {
      if (this.error) throw this.error
      throw new ERR_CONNECTION_CLOSED(this.sessionId.toString('hex'))
    }

    return this._waitForEvent('connect')
  }

  async addMediaStream (mediaStream) {
    await this.ready()
    return this.stream.addStream(mediaStream)
  }

  async deleteMediaStream (mediaStream) {
    await this.ready()
    return this.stream.removeStream(mediaStream)
  }

  waitForMediaStream () {
    return this._waitForEvent('stream')
  }

  destroy (err) {
    this.stream.destroy(err)
  }

  async waitForClose () {
    if (this.destroyed) return
    return this.once(['error', 'closed', 'simple-peer-closed'])
  }

  async _open () {
    const timeout = setTimeout(() => {
      this.destroy(new ERR_SIGNAL_TIMEOUT(this.signals))
    }, this.timeout)

    const ready = this.ready()

    this[kSignalBatch]
      .open({
        peer: this,
        onSignal: (batch) => {
          this.signals = [...this.signals, ...batch]
          return this[kOnSignal](this, batch)
        },
        onClose: (err) => {
          if (err) process.nextTick(() => this.destroy(err))
        }
      })

    if (!this.initiator) {
      if (!this[kOffer]) await this.once('offer-updated')
      this[kOffer].forEach(signal => this.stream.signal(signal))
    }

    return ready.finally(() => {
      clearTimeout(timeout)
    })
  }

  _close () {
    if (this.destroyed) return
    process.nextTick(() => this.stream.destroy())
    return new Promise(resolve => eos(this.stream, () => resolve()))
  }

  _initializeSimplePeer () {
    const { streams = [], ...opts } = this.simplePeerOptions
    this.stream = new SimplePeer({ ...opts, initiator: this.initiator })
    streams.forEach(stream => this.addMediaStream(stream).catch(() => {}))

    // close stream support
    this.stream.close = () => process.nextTick(() => this.stream.destroy())

    const onStream = mediaStream => this.emit('stream', mediaStream).catch(() => {})
    const onSignal = signal => {
      if (this.connected && !this.subscribeMediaStream) {
        this[kSignalBatch].close()
        this.emit('signal', signal).catch(() => {})
        return
      }

      this[kSignalBatch].add(signal)
    }

    const onError = error => {
      this.emit('error', error).catch(() => {})
    }

    const onConnect = () => this.emit('connect').catch(() => {})

    const onClose = () => {
      this[kSignalBatch].close()
      this.stream.removeListener('stream', onStream)
      this.stream.removeListener('signal', onSignal)
      this.stream.removeListener('error', onError)
      this.stream.removeListener('connect', onConnect)
      this.close().catch(() => {})
      this.emit('simple-peer-closed')
    }

    this.stream.on('stream', onStream)
    this.stream.on('signal', onSignal)
    this.stream.once('error', onError)
    this.stream.once('connect', onConnect)
    this.stream.once('close', onClose)
  }

  async _setRemoteMetadata (metadata) {
    assert(!metadata || typeof metadata === 'object', 'remoteMetadata must be an object')
    this[kRemoteMetadata] = metadata
    await this.emit('remote-metadata-updated', metadata)
  }

  _setOffer (offer) {
    this[kOffer] = offer
    this.emit('offer-updated', this[kOffer]).catch(err => {
      console.error(err)
    })
  }

  _setAnswer (answer) {
    this[kAnswer] = answer
    this.emit('answer-updated', this[kAnswer]).catch(err => {
      console.error(err)
    })
  }

  async _waitForEvent (eventName) {
    if (this.destroyed) {
      if (this.error) throw this.error
      throw new ERR_CONNECTION_CLOSED(this.sessionId.toString('hex'))
    }

    return this.once([eventName, 'error', 'closed', 'simple-peer-closed']).then(data => {
      if (data instanceof Error) {
        throw data
      }

      if (this.destroyed) throw new ERR_CONNECTION_CLOSED(this.sessionId.toString('hex'))

      return data
    })
  }

  async _waitForAnswer () {
    if (this[kAnswer]) return this[kAnswer]
    return this._waitForEvent('answer-updated')
  }
}
