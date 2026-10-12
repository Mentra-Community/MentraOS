/**
 * @fileoverview Portal sign-in transactions: `state`, `nonce` and the PKCE
 * verifier between a portal's login redirect and its callback.
 *
 * The browser holds an opaque cookie value for ten minutes; Core stores only
 * its SHA-256. A transaction is consumed once, atomically
 * (`findOneAndDelete`), and only with its own `state`, so two tabs finishing
 * the same callback yield one sign-in, and a replayed `state` yields none.
 */

import {LoginTransactionModel} from "../../models/login-transaction.model"
import type {PortalKind} from "./browser-session.service"
import {randomToken, sha256Hex} from "./random"

export const LOGIN_TRANSACTION_TTL_MS = 10 * 60_000
const MAX_COOKIE_LENGTH = 256

export interface LoginTransaction {
  portal: PortalKind
  state: string
  nonce: string
  pkceVerifier: string
  returnTo: string
  expiresAt: Date
}

export async function startLoginTransaction(
  portal: PortalKind,
  returnTo: string,
  now: Date = new Date(),
): Promise<{cookieValue: string; tx: LoginTransaction}> {
  const cookieValue = randomToken()
  const tx: LoginTransaction = {
    portal,
    state: randomToken(),
    nonce: randomToken(),
    pkceVerifier: randomToken(),
    returnTo,
    expiresAt: new Date(now.getTime() + LOGIN_TRANSACTION_TTL_MS),
  }
  await LoginTransactionModel.create({txHash: sha256Hex(cookieValue), ...tx})
  return {cookieValue, tx}
}

/** The transaction, removed so it cannot be used again; null for a wrong state, an expired, a used, or an unknown one. */
export async function consumeLoginTransaction(
  cookieValue: string,
  state: string,
  now: Date = new Date(),
): Promise<LoginTransaction | null> {
  if (!cookieValue || cookieValue.length > MAX_COOKIE_LENGTH || !state) return null
  const row = await LoginTransactionModel.findOneAndDelete({
    txHash: sha256Hex(cookieValue),
    state,
    expiresAt: {$gt: now},
  }).lean()
  if (!row) return null
  return {
    portal: row.portal as PortalKind,
    state: row.state,
    nonce: row.nonce,
    pkceVerifier: row.pkceVerifier,
    returnTo: row.returnTo,
    expiresAt: row.expiresAt,
  }
}
