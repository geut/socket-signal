const nanoerror = require('nanoerror')

function createError (code, message) {
  exports[code] = nanoerror(code, message)
}

createError('ERR_ARGUMENT_INVALID', '%s')
