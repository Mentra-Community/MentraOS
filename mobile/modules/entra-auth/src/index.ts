import {NativeModule, requireOptionalNativeModule} from "expo"

export interface EntraConfiguration {
  authorityUrl: string
  clientId: string
}

export interface EntraAccount {
  accountId: string
  subject: string
  tenantId: string
  username: string | null
  displayName: string | null
}

export interface EntraTokenResult extends EntraAccount {
  accessToken: string
  expiresAt: number
  scopes: string[]
}

declare class MentraEntraAuthModule extends NativeModule {
  getAccount(configuration: EntraConfiguration): Promise<EntraAccount | null>
  signIn(configuration: EntraConfiguration, scopes: string[]): Promise<EntraTokenResult>
  acquireToken(configuration: EntraConfiguration, scopes: string[], forceRefresh?: boolean): Promise<EntraTokenResult>
  signOut(configuration: EntraConfiguration): Promise<void>
}

export default requireOptionalNativeModule<MentraEntraAuthModule>("MentraEntraAuth")
