import { NanoresourcePromise } from 'nanoresource-promise'
import SimplePeer from 'simple-peer'
import assert from 'nanocustomassert'
import pEvent from 'p-event'
import eos from 'end-of-stream'
import Emittery from 'emittery'

import { SignalBatch } from './signal-batch.js'
import { ERR_CONNECTION_CLOSED, ERR_SIGNAL_TIMEOUT } from './errors.js'

const kMetadata = Symbol('peer.metadata')
const kRemoteMetadata = Symbol('peer.remotemetadata')
const kOnSignal = Symbol('peer.onsignal')
const kOffer = Symbol('peer.offer')
const kSignalBatch = Symbol('peer.signalbatch')

export class Peer extends NanoresourcePromise {
  constructor (opts = {}) {
    super()

    new Emittery().bindMethods(this)

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
    return this.stream.destroyed
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
      throw new ERR_CONNECTION_CLOSED()
    }

    return pEvent(this, 'connect', {
      rejectionEvents: ['error', 'close']
    })
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
    return pEvent(this, 'stream', {
      rejectionEvents: ['error', 'close']
    })
  }

  destroy (err) {
    this.stream.destroy(err)
  }

  async open (offer) {
    if (offer) this[kOffer] = offer
    return super.open()
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

    if (!this.initiator && this[kOffer]) {
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
      this.emit('close')
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
}
