const { SocketSignalServer } = require('..')
const log = require('debug')('socketsignal:test')

class ServerTest extends SocketSignalServer {
  constructor () {
    super()

    this._peersByTopic = new Map()
  }

  addPeer (rpc, id, topic) {
    const topicStr = topic.toString('hex')
    const idStr = id.toString('hex')

    const peers = this._peersByTopic.get(topicStr) || new Map()
    peers.set(idStr, { rpc, id })

    this._peersByTopic.set(topicStr, peers)
  }

  deletePeer (id, topic) {
    const idStr = id.toString('hex')

    if (!topic) {
      this._peersByTopic.forEach((peers, topic) => {
        if (peers.delete(idStr)) {
          log('peer-leave', idStr + ' from ' + topic)
        }
      })
      return
    }

    const topicStr = topic.toString('hex')
    if (this._peersByTopic.has(topicStr) && this._peersByTopic.get(topicStr).delete(idStr)) {
      log('peer-leave', idStr + ' from ' + topicStr)
    }
  }

  getPeers (topic) {
    const topicStr = topic.toString('hex')
    if (!this._peersByTopic.has(topicStr)) return []
    return Array.from(this._peersByTopic.get(topicStr).values()).map(peer => peer.id)
  }

  findPeer (id, topic) {
    const idStr = id.toString('hex')
    const peers = this._peersByTopic.get(topic.toString('hex'))
    if (!peers || !peers.has(idStr)) {
      throw new Error('peer not found')
    }

    return peers.get(idStr)
  }

  _onSocket (socket) {
    this.addSocket(socket).catch(err => process.nextTick(() => this.emit('error', err)))
  }

  async _close () {
    this._server.removeListener('connection', this._onSocket.bind(this))
    this._server.close()
    await super.close()
  }

  async _onDisconnect (rpc) {
    let id
    this._peersByTopic.forEach(peers => {
      for (const [key, peer] of peers) {
        if (peer.rpc === rpc) {
          id = peer.id
          peers.delete(key)
          break
        }
      }
    })
    if (id) {
      log('peer-disconnected', id.toString('hex'))
    }
  }

  async _onJoin (rpc, data) {
    this.addPeer(rpc, data.id, data.topic)
    log('peer-join', data.id.toString('hex') + ' in ' + data.topic.toString('hex'))
    return this.getPeers(data.topic)
  }

  async _onLeave (_, data) {
    this.deletePeer(data.id, data.topic)
  }

  async _onOffer (rpc, data) {
    const remotePeer = this.findPeer(data.remoteId, data.topic)
    log(`peer-offer ${data.id.toString('hex')} -> ${data.remoteId.toString('hex')}`)
    return remotePeer.rpc.call('offer', data)
  }

  async _onLookup (rpc, data) {
    return this.getPeers(data.topic)
  }

  async _onCandidates (rpc, data) {
    const remotePeer = this.findPeer(data.remoteId, data.topic)
    log(`peer-candidates ${data.id.toString('hex')} -> ${data.remoteId.toString('hex')}`)
    remotePeer.rpc.emit('candidates', data)
  }
}

module.exports = ServerTest
