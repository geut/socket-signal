import nanoerror from 'nanoerror'

export const ERR_ARGUMENT_INVALID = nanoerror('ERR_ARGUMENT_INVALID', '%s')
export const ERR_PEER_NOT_FOUND = nanoerror('ERR_PEER_NOT_FOUND', 'peer not found: %s')
export const ERR_CONNECTION_CLOSED = nanoerror('ERR_CONNECTION_CLOSED', 'connection closed: %s')
export const ERR_SIGNAL_TIMEOUT = nanoerror('ERR_SIGNAL_TIMEOUT', 'Timeout trying to establish a connection. SIGNALS: %j')
