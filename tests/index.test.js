import crypto from 'crypto'
import through from 'through2'
import duplexify from 'duplexify'
import wrtc from 'wrtc'
import pEvent from 'p-event'
import { jest } from '@jest/globals'

import { SocketSignalClient, Peer, SocketSignalServerMap } from '../src/index.js'

jest.setTimeout(60 * 1000)

const createSocket = () => {
  const t1 = through()
  const t2 = through()

  return { from: duplexify(t1, t2), to: duplexify(t2, t1) }
}

const signalFactory = server => (opts = {}) => {
  const { from, to } = createSocket()

  const client = new SocketSignalClient(from, {
    timeout: 15 * 1000,
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
  const MAX_SIGNALS = 10

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
  expect(joinEvent).toHaveBeenCalledWith(expect.objectContaining({
    topic: expect.any(Buffer),
    peers: expect.any(Array)
  }))
  expect(lookupEvent).toHaveBeenCalledTimes(signals.length)
  expect(lookupEvent).toHaveBeenCalledWith(expect.objectContaining({
    topic: expect.any(Buffer),
    peers: expect.any(Array)
  }))

  const waitForConnections = []
  for (let i = 0; i < signals.length; i++) {
    if (!signals[i + 1]) {
      waitForConnections.push(pEvent(signals[i], 'peer-connected'))
      continue
    }

    const remoteSignal = signals[i].connect(topic, signals[i + 1].id)
    remoteSignal.on('remote-metadata-updated', peerMetadataEvent)
    waitForConnections.push(pEvent(signals[i + 1], 'peer-connected'))
    waitForConnections.push(remoteSignal.ready())
  }

  await Promise.all(waitForConnections)

  for (let i = 0; i < signals.length; i++) {
    // first and last peer with one connection
    const connections = (i === 0 || i === (signals.length - 1)) ? 1 : 2
    expect(signals[i].peersConnected.length).toBe(connections)
  }

  expect(peerMetadataEvent).toHaveBeenCalledTimes(signals.length - 1)
  expect(peerEvent).toHaveBeenCalledTimes((signals.length * 2) - 2)
  expect(peerEvent).toHaveBeenCalledWith(expect.objectContaining({
    peer: expect.any(Peer)
  }))
  expect(peerConnectingEvent).toHaveBeenCalledTimes((signals.length * 2) - 2)
  expect(peerConnectingEvent).toHaveBeenCalledWith(expect.objectContaining({
    peer: expect.any(Peer)
  }))

  for (const signal of signals) {
    await signal.leave(topic)
    await signal.close()
  }

  expect(leaveEvent).toHaveBeenCalledTimes(signals.length)
  expect(leaveEvent).toHaveBeenCalledWith(expect.objectContaining({
    topic: expect.any(Buffer)
  }))

  expect(server.connections.size).toBe(0)

  await server.close()
})

test('rejects connection', async () => {
  expect.assertions(10)

  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const signal1 = createSignal()
  const signal2 = createSignal()

  signal2.onIncomingPeer((peer) => {
    expect(signal2.peersConnecting.length).toBe(1)
    expect(signal2.peersConnected.length).toBe(0)
    throw new Error('peer-rejected')
  })

  await expect(signal1.connect(topic, signal2.id).ready()).rejects.toThrow('peer not found')
  await signal1.join(topic)
  await signal2.join(topic)

  const remotePeer = signal1.connect(topic, signal2.id)
  expect(signal1.peersConnecting.length).toBe(1)
  expect(signal1.peersConnected.length).toBe(0)
  await expect(remotePeer.ready()).rejects.toThrow('peer-rejected')

  expect(signal1.peersConnecting.length).toBe(0)
  expect(signal1.peersConnected.length).toBe(0)
  expect(signal2.peersConnecting.length).toBe(0)
  expect(signal2.peersConnected.length).toBe(0)

  await signal1.close()
  await signal2.close()

  await server.close()
})

test('metadata onIncomingPeer', async () => {
  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const signal1 = createSignal({ metadata: { user: 'peer1' } })
  const signal2 = createSignal({ metadata: { user: 'peer2' } })

  signal2.onIncomingPeer(async (peer) => {
    await peer.setMetadata({ password: '456' })
  })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1.connect(topic, signal2.id, { metadata: { password: '123' } })

  const [{ peer: remotePeer2 }, { peer: remotePeer1 }] = await Promise.all([
    signal1.once('peer-connected'),
    signal2.once('peer-connected')
  ])

  expect(remotePeer2.remoteMetadata).toEqual({ user: 'peer2', password: '456' })
  expect(remotePeer1.remoteMetadata).toEqual({ user: 'peer1', password: '123' })

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

  signal2.onOffer((message) => {
    expect(message.data).toBeDefined()
    expect(message.metadata).toEqual({ user: 'peer1', password: '123' })

    return {
      metadata: { password: '456' }
    }
  })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1.connect(topic, signal2.id, { metadata: { password: '123' } })

  const [{ peer: remotePeer2 }, { peer: remotePeer1 }] = await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  expect(remotePeer2.remoteMetadata).toEqual({ user: 'peer2', password: '456' })
  expect(remotePeer1.remoteMetadata).toEqual({ user: 'peer1', password: '123' })

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

  signal1.onAnswer((message) => {
    expect(message.data).toBeDefined()
    expect(message.metadata).toEqual({ user: 'peer2' })
  })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1.connect(topic, signal2.id)

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

  signal1.connect(topic, signal2.id)
  const second = signal1.connect(topic, signal2.id)

  await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  await second.ready()
  await pEvent(signal2, 'peer-connected')

  expect(signal1.peersConnected.length).toBe(2)
  expect(signal2.peersConnected.length).toBe(2)

  await signal1.close()
  await signal2.close()
  await server.close()
})

test('media stream', async () => {
  async function getRemoteStream (peer) {
    if (peer.stream._remoteStreams.length > 0) {
      return peer.stream._remoteStreams[0]
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
      peer.subscribeMediaStream = true
    })

  const signal2 = createSignal()
    .onIncomingPeer(peer => {
      peer.subscribeMediaStream = true
    })

  await signal1.join(topic)
  await signal2.join(topic)

  signal1
    .connect(topic, signal2.id)
    .subscribeMediaStream = true

  await Promise.all([
    pEvent(signal1, 'peer-connecting'),
    pEvent(signal2, 'peer-connecting')
  ])

  const peer1 = signal1.peers[0]
  const peer2 = signal2.peers[0]

  const stream2 = await wrtc.getUserMedia({ audio: true })
  await peer2.addMediaStream(stream2)

  expect((await getRemoteStream(peer1)).id).toBe(stream2.id)
  expect((await getRemoteStream(peer2)).id).toBe(stream1.id)
  await signal1.close()
  await signal2.close()
  await server.close()
})

test('connect without being in a swarm', async () => {
  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const signal1 = createSignal({ metadata: { user: 'peer1' } })
  const signal2 = createSignal({ metadata: { user: 'peer2' } })

  await signal2.join(topic)

  signal1.connect(topic, signal2.id)

  await Promise.all([
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  await signal1.close()
  await signal2.close()
  await server.close()
})

test('remoteConnect', async () => {
  const topic = crypto.randomBytes(32)
  const server = new SocketSignalServerMap()
  const createSignal = signalFactory(server)

  const signal1 = createSignal({ metadata: { user: 'peer1' } })
  const signal2 = createSignal({ metadata: { user: 'peer2' } })

  await signal1.join(topic)
  await signal2.join(topic)

  const peer = signal1.remoteConnect(topic, signal2.id)

  await Promise.all([
    peer.ready(),
    pEvent(signal1, 'peer-connected'),
    pEvent(signal2, 'peer-connected')
  ])

  await signal1.close()
  await signal2.close()
  await server.close()
})
