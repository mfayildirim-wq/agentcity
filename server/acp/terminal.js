// terminal/* für Agenten – wird in Paket 4 über pty/manager umgesetzt.
import { RequestError } from '@agentclientprotocol/sdk';

const unsupported = () => { throw RequestError.methodNotFound('terminal/* (noch nicht unterstützt)'); };

// Liefert die Client-Methoden für Terminals; bis Paket 4 alle „nicht unterstützt“.
export function createTerminalHandlers() {
  return {
    supported: false,
    createTerminal: unsupported,
    terminalOutput: unsupported,
    waitForTerminalExit: unsupported,
    killTerminal: unsupported,
    releaseTerminal: unsupported,
  };
}
