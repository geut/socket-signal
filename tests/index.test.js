const crypto = require('crypto')
const through = require('through2')
const duplexify = require('duplexify')
const wrtc = require('wrtc')
const pEvent = require('p-event')

const { SocketSignalClient, Peer } = require('..')
const { SocketSignalServerMap } = require('..')

const createSocket = () => {
  const t1 = through()
  const t2 = through()

  return { from: duplexify(t1, t2), to: duplexify(t2, t1) }
}

const peerFactory = server => (opts = {}) => {
  const { from, to } = createSocket()

  const client = new SocketSignalClient(from, {
    timeout: 2 * 1000,
    ...opts,
    simplePeer: {
      wrtc,
      ...opts.simplePeer
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
  expect.assertions((MAX_PEERS * 3) + 11)

  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
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
  expect(joinEvent).toHaveBeenCalledWith(topic, expect.any(Array))
  expect(lookupEvent).toHaveBeenCalledTimes(peers.length)
  expect(lookupEvent).toHaveBeenCalledWith(topic, expect.any(Array))

  for (let i = 0; i < peers.length; i++) {
    if (peers[i + 1]) {
      const remotePeer = peers[i].connect(peers[i + 1].id, topic)
      remotePeer.on('metadata-updated', peerMetadataEvent)
      await pEvent(peers[i + 1], 'peer-connected')
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

  expect(leaveEvent).toHaveBeenCalledTimes(peers.length)
  expect(leaveEvent).toHaveBeenCalledWith(topic)

  await server.close()
})

test('rejects connection', async (done) => {
  expect.assertions(10)

  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createPeer = peerFactory(server)

  const peer1 = createPeer()
  const peer2 = createPeer()

  peer2.onIncomingPeer((peer) => {
    expect(peer2.peersConnecting.length).toBe(1)
    expect(peer2.peers.length).toBe(0)
    throw new Error('peer-rejected')
  })

  await expect(peer1.connect(peer2.id, topic).waitForConnection()).rejects.toThrow('peer not found')
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

  await peer1.close()
  await peer2.close()

  server.close().finally(done)
})

test('metadata', async () => {
  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createPeer = peerFactory(server)

  const peer1 = createPeer({ metadata: { user: 'peer1' } })
  const peer2 = createPeer({ metadata: { user: 'peer2' } })

  peer2.onIncomingPeer((peer) => {
    peer.localMetadata = { password: '456' }
  })

  await peer1.join(topic)
  await peer2.join(topic)

  peer1.connect(peer2.id, topic, { password: '123' })

  const [remotePeer2, remotePeer1] = await Promise.all([
    pEvent(peer1, 'peer-connected'),
    pEvent(peer2, 'peer-connected')
  ])

  expect(remotePeer2.metadata).toEqual({ user: 'peer2', password: '456' })
  expect(remotePeer1.metadata).toEqual({ user: 'peer1', password: '123' })

  await peer1.close()
  await peer2.close()
  await server.close()
})

test('allow two connections of the same peer', async () => {
  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createPeer = peerFactory(server)

  const peer1 = createPeer({ metadata: { user: 'peer1' } })
  const peer2 = createPeer({ metadata: { user: 'peer2' } })

  peer2.onIncomingPeer((peer) => {
    peer.localMetadata = { password: '456' }
  })

  await peer1.join(topic)
  await peer2.join(topic)

  peer1.connect(peer2.id, topic, { password: '123' })
  const second = peer1.connect(peer2.id, topic, { password: '123' })

  const [remotePeer2, remotePeer1] = await Promise.all([
    pEvent(peer1, 'peer-connected'),
    pEvent(peer2, 'peer-connected')
  ])

  await second.waitForConnection()
  await pEvent(peer2, 'peer-connected')

  expect(peer1.peers.length).toBe(2)
  expect(peer2.peers.length).toBe(2)

  expect(remotePeer2.metadata).toEqual({ user: 'peer2', password: '456' })
  expect(remotePeer1.metadata).toEqual({ user: 'peer1', password: '123' })

  await peer1.close()
  await peer2.close()
  await server.close()
})

test('media stream', async () => {
  async function getRemoteStream (peer) {
    if (peer._remoteStreams.length > 0) {
      return peer._remoteStreams[0]
    }
    return pEvent(peer, 'stream')
  }

  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createPeer = peerFactory(server)

  const stream1 = await wrtc.getUserMedia({ audio: true })

  const signal1 = createPeer({
    metadata: {
      user: 'peer1'
    },
    simplePeer: {
      streams: [stream1]
    }
  })
  const signal2 = createPeer({ metadata: { user: 'peer2' } })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1.connect(signal2.id, topic, { password: '123' })

  await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  const peer1 = signal1.peers[0]
  const peer2 = signal2.peers[0]

  // data messages should be still working
  peer1.send('ping')
  expect((await pEvent(peer2, 'data')).toString()).toBe('ping')
  peer1.send(Buffer.from('ping'))
  expect((await pEvent(peer2, 'data')).toString()).toBe('ping')

  const stream2 = await wrtc.getUserMedia({ audio: true })
  peer2.addStream(stream2)

  expect((await getRemoteStream(peer1)).id).toBe(stream2.id)
  expect((await getRemoteStream(peer2)).id).toBe(stream1.id)

  await signal1.close()
  await signal2.close()
  await server.close()
})

test('extension data', async () => {
  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createPeer = peerFactory(server)

  const signal1 = createPeer({ metadata: { user: 'peer1' } })
  const signal2 = createPeer({ metadata: { user: 'peer2' } })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1.connect(signal2.id, topic, { password: '123' })

  await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  const peer1 = signal1.peers[0]
  const peer2 = signal2.peers[0]

  const onData = jest.fn()

  peer1.sendExtensionData('custom', Buffer.from('ping'))
  peer2.on('data', onData)
  expect((await pEvent(peer2, 'extension-data')).value.toString()).toBe('ping')
  expect(onData).not.toHaveBeenCalled()

  await signal1.close()
  await signal2.close()
  await server.close()
})
