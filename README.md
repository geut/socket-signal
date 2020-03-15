# socket-signal

[![Build Status](https://travis-ci.com/geut/socket-signal.svg?branch=master)](https://travis-ci.com/geut/socket-signal)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

> Signal abstraction to create WebRTC connections through sockets.

This module provides a common interface (for the client and server) to build your own signal.

If you want to use a `ready to use` implementation check: [socket-signal-websocket](https://github.com/geut/socket-signal-websocket).

## <a name="install"></a> Install

```
$ npm install socket-signal
```

## <a name="usage"></a> Usage

### Client

The client interface provides almost everything that you need to start a basic signal client (most of the times you won't need to add more features).

```javascript
const { SocketSignalClient } = require('socket-signal')

class YourClient extends SocketSignalClient {}

const client = new YourClient(socket)

;(async () => {
  await client.open()

  client.onIncomingPeer(async (peer) => {
    if (validPeer(peer)) return
    throw new Error('invalid peer')
  })

  const peersForThatTopic = await client.join(topic)

  const remotePeer = client.connect(peersForThatTopic[0], topic)

  try {
    await remotePeer.waitForConnection()
    // SimplePeer connected
  } catch(err) {
    // SimplePeer rejected
  }
})()
```

### Server

If you want a server with a minimal implementation to handle peer connections you can use [SocketSignalServerMap](lib/server-map.js) or
build your own abstraction on top the server interface `SocketSignalServer`.

## <a name="issues"></a> Issues

:bug: If you found an issue we encourage you to report it on [github](https://github.com/geut/socket-signal/issues). Please specify your OS and the actions to reproduce it.

## <a name="contribute"></a> Contributing

:busts_in_silhouette: Ideas and contributions to the project are welcome. You must follow this [guideline](https://github.com/geut/socket-signal/blob/master/CONTRIBUTING.md).

## License

MIT © A [**GEUT**](http://geutstudio.com/) project
