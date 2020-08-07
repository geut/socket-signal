module.exports = class CacheSignal {
  constructor ({ client, peer, mediaStream = false, onError = () => {} }) {
    this._client = client
    this._peer = peer
    this._mediaStream = mediaStream
    this._onError = onError
    this._cache = []
  }

  get length () {
    return this._cache.length
  }

  get closed () {
    return (this._client.closed || this._peer.destroyed)
  }

  push (signal) {
    this._cache.push(signal)
  }

  send () {
    if (this.closed) return
    if (this._cache.length === 0) return

    process.nextTick(() => {
      if (this.closed) return
      if (this._cache.length === 0) return

      this._client.rpc.emit('signal', this._client._buildMessage({
        remoteId: this._peer.id,
        topic: this._peer.topic,
        sessionId: this._peer.sessionId,
        data: this._cache,
        localMetadata: this._peer.localMetadata,
        mediaStream: this._mediaStream
      })).catch(this._onError)

      this._cache = []
    })
  }
}
