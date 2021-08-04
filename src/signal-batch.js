import pLimit from 'p-limit'

export class SignalBatch {
  constructor () {
    this._limit = pLimit(1)
    this._cache = []
    this._opened = false
    this._closed = false
  }

  open (opts = {}) {
    if (this._opened) return
    const { peer, onSignal, onClose } = opts
    this._peer = peer
    this._onSignal = (batch) => onSignal(batch)
    this._onClose = (err) => onClose(err)
    this._opened = true
    this._run()
  }

  add (signal) {
    this._cache.push(signal)
    this._run()
  }

  close (err) {
    if (this._closed) return
    this._limit.clearQueue()
    this._closed = true
    this._onClose(err)
  }

  _run () {
    if (this._opened && !this._closed) {
      const peer = this._peer

      this._limit(async () => {
        this._limit.clearQueue()
        if (this._cache.length === 0) return

        if (peer.destroyed || (peer.connected && !peer.subscribeMediaStream)) {
          this.close()
          return
        }

        let prev
        let ms = 300
        do {
          prev = this._cache.length
          await new Promise(resolve => setTimeout(resolve, ms))
          ms = 1
        } while (!this._closed && prev < this._cache.length && this._cache.length < 4)

        if (peer.destroyed || (peer.connected && !peer.subscribeMediaStream)) {
          this.close()
          return
        }

        const batch = this._cache
        this._cache = []
        return this._onSignal(batch)
      }).catch(err => {
        this.close(err)
      })
    }
  }
}
