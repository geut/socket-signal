const crypto = require('crypto')
const through = require('through2')
const duplexify = require('duplexify')
const wrtc = require('wrtc')
const once = require('events.once')

const { SocketSignalClient, Peer } = require('..')
const ServerTest = require('./server-test')

const createSocket = () => {
  const t1 = through()
  const t2 = through()

  return { from: duplexify(t1, t2), to: duplexify(t2, t1) }
}

const peerFactory = server => () => {
  const { from, to } = createSocket()

  const client = new SocketSignalClient(from, {
    timeout: 2 * 1000,
    simplePeer: {
      wrtc
    }
  })

  server.addSocket(to)

  return client
}

const MAX_PEERS = 50

/**
 * node webrtc takes to long to close the connections
 * so we use --forceExit in our tests
 */

test('basic connection', async () => {
  expect.assertions((MAX_PEERS * 3) + 9)

  const topic = crypto.randomBytes(32)
  const server = new ServerTest()
  const createPeer = peerFactory(server)

  const joinEvent = jest.fn()
  const leaveEvent = jest.fn()
  const lookupEvent = jest.fn()
  const peerEvent = jest.fn()
  const peerConnectingEvent = jest.fn()
  const peerMetadataEvent = jest.fn()

  const peers = [...Array(MAX_PEERS).keys()].map(() => {
    const peer = createPeer()
    peer.on('join', joinEvent)
    peer.on('leave', leaveEvent)
    peer.on('lookup', lookupEvent)
    peer.on('peer-connecting', peerConnectingEvent)
    peer.on('peer', peerEvent)
    return peer
  })

  let i = 1
  for (const peer of peers) {
    const lookupResult = await peer.join(topic)
    expect(lookupResult.length).toBe(i)
    await expect(peer.lookup(topic)).resolves.toEqual(lookupResult)
    i++
  }

  expect(joinEvent).toHaveBeenCalledTimes(peers.length)
  expect(joinEvent).toHaveBeenCalledWith(expect.any(Array), topic)
  expect(lookupEvent).toHaveBeenCalledTimes(peers.length)
  expect(lookupEvent).toHaveBeenCalledWith(expect.any(Array), topic)

  for (let i = 0; i < peers.length; i++) {
    if (peers[i + 1]) {
      const remotePeer = peers[i].connect(peers[i + 1].id, topic)
      remotePeer.on('metadata-updated', peerMetadataEvent)
      await once(peers[i + 1], 'peer-connected')
      await remotePeer.waitForConnection()
    }

    // first and last peer with one connection
    const connections = (i === 0 || i === (peers.length - 1)) ? 1 : 2
    expect(peers[i].peers.length).toBe(connections)
  }

  expect(peerMetadataEvent).toHaveBeenCalledTimes(peers.length - 1)
  expect(peerEvent).toHaveBeenCalledTimes((peers.length * 2) - 2)
  expect(peerEvent).toHaveBeenCalledWith(expect.any(Peer))
  expect(peerConnectingEvent).toHaveBeenCalledTimes((peers.length * 2) - 2)
  expect(peerConnectingEvent).toHaveBeenCalledWith(expect.any(Peer))

  for (const peer of peers) {
    await peer.leave(topic)
    await peer.close()
  }
})

test('rejects connection', async () => {
  expect.assertions(9)

  const topic = crypto.randomBytes(32)
  const server = new ServerTest()
  const createPeer = peerFactory(server)

  const peer1 = createPeer()
  const peer2 = createPeer()

  peer2.onIncomingPeer(() => {
    expect(peer2.peersConnecting.length).toBe(1)
    expect(peer2.peers.length).toBe(0)
    throw new Error('peer-rejected')
  })

  await peer1.join(topic)
  await peer2.join(topic)

  const remotePeer = peer1.connect(peer2.id, topic)
  expect(peer1.peersConnecting.length).toBe(1)
  expect(peer1.peers.length).toBe(0)
  await expect(remotePeer.waitForConnection()).rejects.toThrow('peer-rejected')

  expect(peer1.peersConnecting.length).toBe(0)
  expect(peer1.peers.length).toBe(0)
  expect(peer2.peersConnecting.length).toBe(0)
  expect(peer2.peers.length).toBe(0)
})
