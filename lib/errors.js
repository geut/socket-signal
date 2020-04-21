const nanoerror = require('nanoerror')

function createError (code, message) {
  exports[code] = nanoerror(code, message)
}

createError('ERR_ARGUMENT_INVALID', '%s')
createError('ERR_PEER_NOT_FOUND', 'peer not found: %s')
createError('ERR_PEER_VERSION_INVALID', 'the peer version is %s and received %s')
