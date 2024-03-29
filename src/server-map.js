import debug from 'debug'

import { SocketSignalServer } from './server.js'
import { ERR_PEER_NOT_FOUND } from './errors.js'

const log = debug('socket-signal:server-map')

export class SocketSignalServerMap extends SocketSignalServer {
  constructor (opts = {}) {
    super(opts)

    this._peersByTopic = new Map()
  }

  async addPeer (rpc, id, topic) {
    const topicStr = topic.toString('hex')
    const idStr = id.toString('hex')

    const peers = this._peersByTopic.get(topicStr) || new Map()
    peers.set(idStr, { rpc, id })

    this._peersByTopic.set(topicStr, peers)
  }

  async deletePeer (id, topic) {
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

  async getPeers (topic) {
    const topicStr = topic.toString('hex')
    if (!this._peersByTopic.has(topicStr)) return []
    return Array.from(this._peersByTopic.get(topicStr).values()).map(peer => peer.id)
  }

  async findPeer (id, topic) {
    const idStr = id.toString('hex')
    const peers = this._peersByTopic.get(topic.toString('hex'))

    if (!peers || !peers.has(idStr)) {
      throw new ERR_PEER_NOT_FOUND(idStr)
    }

    return peers.get(idStr)
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
    await this.addPeer(rpc, data.id, data.topic)
    log('on-join', data.id.toString('hex') + ' in ' + data.topic.toString('hex'))
    return this.getPeers(data.topic)
  }

  async _onLeave (_, data) {
    log('on-leave', data.id.toString('hex') + ' in ' + data.topic.toString('hex'))
    await this.deletePeer(data.id, data.topic)
  }

  async _onOffer (_, data) {
    const remotePeer = await this.findPeer(data.remoteId, data.topic)
    log(`on-offer ${data.id.toString('hex')} -> ${data.remoteId.toString('hex')}`)
    return remotePeer.rpc.call('offer', data)
  }

  async _onRemoteConnect (_, data) {
    const remotePeer = await this.findPeer(data.remoteId, data.topic)
    log(`on-remote-connect ${data.id.toString('hex')} -> ${data.remoteId.toString('hex')}`)
    return remotePeer.rpc.call('remoteConnect', data)
  }

  async _onLookup (rpc, data) {
    return this.getPeers(data.topic)
  }

  async _onSignal (rpc, data) {
    const remotePeer = await this.findPeer(data.remoteId, data.topic)
    log(`peer-signal ${data.id.toString('hex')} -> ${data.remoteId.toString('hex')}`)
    remotePeer.rpc.emit('signal', data).catch(() => {})
  }
}
