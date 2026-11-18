/**
 * The classified failure shared by the transfer engine, its routes, and the
 * boxes bridge.
 *
 * @module dsh-session-transfer/transfer-error
 */

/** A failure whose message is meant for the user unchanged. */
export class TransferError extends Error {
  /**
   * @param message - user-facing explanation.
   * @param options - optional machine-readable code, cause, and extra details.
   */
  constructor(message, options = {}) {
    super(message, options)
    this.name = 'TransferError'
    this.code = options.code ?? 'TRANSFER_FAILED'
  }
}
