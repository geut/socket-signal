const crypto = require('crypto')
const through = require('through2')
const duplexify = require('duplexify')
const wrtc = require('wrtc')
const pEvent = require('p-event')

const { SocketSignalClient, Peer } = require('..')
const { SocketSignalServerMap } = require('..')

jest.setTimeout(10 * 1000)

const createSocket = () => {
  const t1 = through()
  const t2 = through()

  return { from: duplexify(t1, t2), to: duplexify(t2, t1) }
}

const signalFactory = server => (opts = {}) => {
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

/**
 * node webrtc takes to long to close the connections
 * so we use --forceExit in our tests
 */

test('basic connection', async () => {
  const MAX_SIGNALS = 50

  expect.assertions((MAX_SIGNALS * 3) + 13)

  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const joinEvent = jest.fn()
  const leaveEvent = jest.fn()
  const lookupEvent = jest.fn()
  const peerEvent = jest.fn()
  const peerConnectingEvent = jest.fn()
  const peerMetadataEvent = jest.fn()

  const signals = [...Array(MAX_SIGNALS).keys()].map(() => {
    const signal = createSignal()
    signal.on('join', joinEvent)
    signal.on('leave', leaveEvent)
    signal.on('lookup', lookupEvent)
    signal.on('peer-connecting', peerConnectingEvent)
    signal.on('peer-queue', peerEvent)
    return signal
  })

  let i = 1
  for (const signal of signals) {
    const lookupResult = await signal.join(topic)
    expect(lookupResult.length).toBe(i)
    await expect(signal.lookup(topic)).resolves.toEqual(lookupResult)
    i++
  }

  expect(server.connections.size).toBe(MAX_SIGNALS)

  expect(joinEvent).toHaveBeenCalledTimes(signals.length)
  expect(joinEvent).toHaveBeenCalledWith(topic, expect.any(Array))
  expect(lookupEvent).toHaveBeenCalledTimes(signals.length)
  expect(lookupEvent).toHaveBeenCalledWith(topic, expect.any(Array))

  for (let i = 0; i < signals.length; i++) {
    if (signals[i + 1]) {
      const remoteSignal = signals[i].connect(signals[i + 1].id, topic)
      remoteSignal.on('metadata-updated', peerMetadataEvent)
      await pEvent(signals[i + 1], 'peer-connected')
      await remoteSignal.ready()
    }

    // first and last peer with one connection
    const connections = (i === 0 || i === (signals.length - 1)) ? 1 : 2
    expect(signals[i].peers.length).toBe(connections)
  }

  expect(peerMetadataEvent).toHaveBeenCalledTimes(signals.length - 1)
  expect(peerEvent).toHaveBeenCalledTimes((signals.length * 2) - 2)
  expect(peerEvent).toHaveBeenCalledWith(expect.any(Peer))
  expect(peerConnectingEvent).toHaveBeenCalledTimes((signals.length * 2) - 2)
  expect(peerConnectingEvent).toHaveBeenCalledWith(expect.any(Peer))

  for (const signal of signals) {
    await signal.leave(topic)
    await signal.close()
  }

  expect(leaveEvent).toHaveBeenCalledTimes(signals.length)
  expect(leaveEvent).toHaveBeenCalledWith(topic)

  expect(server.connections.size).toBe(0)

  await server.close()
})

test('rejects connection', async (done) => {
  expect.assertions(10)

  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const signal1 = createSignal()
  const signal2 = createSignal()

  signal2.onIncomingPeer((peer) => {
    expect(signal2.peersConnecting.length).toBe(1)
    expect(signal2.peers.length).toBe(0)
    throw new Error('peer-rejected')
  })

  await expect(signal1.connect(signal2.id, topic).ready()).rejects.toThrow('peer not found')
  await signal1.join(topic)
  await signal2.join(topic)

  const remotePeer = signal1.connect(signal2.id, topic)
  expect(signal1.peersConnecting.length).toBe(1)
  expect(signal1.peers.length).toBe(0)
  await expect(remotePeer.ready()).rejects.toThrow('peer-rejected')

  expect(signal1.peersConnecting.length).toBe(0)
  expect(signal1.peers.length).toBe(0)
  expect(signal2.peersConnecting.length).toBe(0)
  expect(signal2.peers.length).toBe(0)

  await signal1.close()
  await signal2.close()

  server.close().finally(done)
})

test('metadata onIncomingPeer', async () => {
  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const signal1 = createSignal({ metadata: { user: 'peer1' } })
  const signal2 = createSignal({ metadata: { user: 'peer2' } })

  signal2.onIncomingPeer((peer) => {
    peer.localMetadata = { password: '456' }
  })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1.connect(signal2.id, topic, { metadata: { password: '123' } })

  const [remotePeer2, remotePeer1] = await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  expect(remotePeer2.metadata).toEqual({ user: 'peer2', password: '456' })
  expect(remotePeer1.metadata).toEqual({ user: 'peer1', password: '123' })

  await signal1.close()
  await signal2.close()
  await server.close()
})

test('metadata onOffer', async () => {
  expect.assertions(4)

  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const signal1 = createSignal({ metadata: { user: 'peer1' } })
  const signal2 = createSignal({ metadata: { user: 'peer2' } })

  signal2.onOffer((data) => {
    expect(data.offer).toBeDefined()
    expect(data.metadata).toEqual({ user: 'peer1', password: '123' })

    return {
      metadata: { password: '456' }
    }
  })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1.connect(signal2.id, topic, { metadata: { password: '123' } })

  const [remotePeer2, remotePeer1] = await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  expect(remotePeer2.metadata).toEqual({ user: 'peer2', password: '456' })
  expect(remotePeer1.metadata).toEqual({ user: 'peer1', password: '123' })

  await signal1.close()
  await signal2.close()
  await server.close()
})

test('onAnswer', async () => {
  expect.assertions(2)

  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const signal1 = createSignal({ metadata: { user: 'peer1' } })
  const signal2 = createSignal({ metadata: { user: 'peer2' } })

  signal1.onAnswer((data) => {
    expect(data.answer).toBeDefined()
    expect(data.metadata).toEqual({ user: 'peer2' })
  })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1.connect(signal2.id, topic)

  await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  await signal1.close()
  await signal2.close()
  await server.close()
})

test('allow two connections of the same peer', async () => {
  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const signal1 = createSignal()
  const signal2 = createSignal()

  await signal1.join(topic)
  await signal2.join(topic)

  signal1.connect(signal2.id, topic)
  const second = signal1.connect(signal2.id, topic)

  await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  await second.ready()
  await pEvent(signal2, 'peer-connected')

  expect(signal1.peers.length).toBe(2)
  expect(signal2.peers.length).toBe(2)

  await signal1.close()
  await signal2.close()
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
  const createSignal = signalFactory(server)

  const stream1 = await wrtc.getUserMedia({ audio: true })

  const signal1 = createSignal({
    simplePeer: {
      streams: [stream1]
    }
  })
    .onIncomingPeer(peer => {
      peer.subscribeMediaStream()
    })

  const signal2 = createSignal()
    .onIncomingPeer(peer => {
      peer.subscribeMediaStream()
    })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1
    .connect(signal2.id, topic)
    .subscribeMediaStream()

  await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  const peer1 = signal1.peers[0]
  const peer2 = signal2.peers[0]

  const stream2 = await wrtc.getUserMedia({ audio: true })
  peer2.addStream(stream2)

  expect((await getRemoteStream(peer1)).id).toBe(stream2.id)
  expect((await getRemoteStream(peer2)).id).toBe(stream1.id)

  await signal1.close()
  await signal2.close()
  await server.close()
})
