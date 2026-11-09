/**
 * OAuth 2.1 Proxy Implementation
 * Provides DCR-compatible interface for non-DCR OAuth providers
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { z } from "zod";

import type {
  AuthorizationParams,
  ClientCode,
  DCRRequest,
  DCRResponse,
  OAuthError,
  OAuthProxyConfig,
  OAuthTransaction,
  ProxyDCRClient,
  RefreshRequest,
  TokenEndpointAuthMethod,
  TokenRequest,
  TokenResponse,
  TokenStorage,
  UpstreamTokenSet,
} from "./types.js";

import {
  ClientIdMetadataError,
  ClientIdMetadataResolver,
  isClientIdMetadataUrl,
} from "./clientIdMetadata.js";
import {
  issuerNamespace,
  OAuthProxyStateStore,
} from "./OAuthProxyStateStore.js";
import {
  DEFAULT_ACCESS_TOKEN_TTL,
  DEFAULT_ACCESS_TOKEN_TTL_NO_REFRESH,
  DEFAULT_AUTHORIZATION_CODE_TTL,
  DEFAULT_REFRESH_TOKEN_TTL,
  DEFAULT_TRANSACTION_TTL,
  DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS,
  TOKEN_ENDPOINT_AUTH_METHODS,
} from "./types.js";
import { ClaimsExtractor } from "./utils/claimsExtractor.js";
import { ConsentManager } from "./utils/consent.js";
import { JWTIssuer } from "./utils/jwtIssuer.js";
import {
  isLoopbackHostname,
  loopbackRedirectMatches,
} from "./utils/loopbackRedirect.js";
import { PKCEUtils } from "./utils/pkce.js";
import {
  EncryptedTokenStorage,
  MemoryTokenStorage,
} from "./utils/tokenStore.js";
import { withoutTrailingSlash } from "./utils/trailingSlash.js";

/**
 * Authorization request parameters owned by the proxy. Entries in
 * `extraAuthorizationParams` with these keys are ignored so configuration
 * can never override the security-critical core of the upstream request.
 */
const RESERVED_AUTHORIZATION_PARAMS: ReadonlySet<string> = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
]);

/**
 * The client a token request came from, and whether it proved it.
 *
 * `authenticated` is true only when the client presented the secret it was
 * issued. Anyone can register through DCR, so a valid secret proves only that
 * the caller is *some* client: every grant is still checked against the client
 * it was issued to.
 */
type TokenEndpointClient = {
  authenticated: boolean;
  client: ProxyDCRClient;
};

/**
 * Which client a passthrough-mode upstream refresh token was issued to. Swap
 * mode keeps this in its token mapping; passthrough hands the client the
 * upstream token itself, so the proxy records it separately.
 */
const passthroughRefreshBindingSchema = z.object({
  clientAuthenticated: z.boolean(),
  clientId: z.string(),
});

/**
 * OAuth 2.1 Proxy
 * Acts as transparent intermediary between MCP clients and upstream OAuth providers
 */
export class OAuthProxy {
  private claimsExtractor: ClaimsExtractor | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private clientIdMetadata: ClientIdMetadataResolver;
  private config: OAuthProxyConfig;
  private consentManager: ConsentManager;
  private issuerNs: string;
  private jwtIssuer?: JWTIssuer;
  /**
   * The fallback storage this proxy created for itself, if any. It runs a
   * cleanup timer that keeps the event loop alive, so `destroy()` has to stop
   * it — and once the storage is wrapped for encryption it is reachable
   * through nothing else. A caller-supplied storage is deliberately not
   * recorded here: its lifetime belongs to the caller.
   */
  private ownedTokenStorage: MemoryTokenStorage | null = null;
  /**
   * Keyed by proxy-issued client_id for authorize/token-exchange lookups and
   * for the defence-in-depth callback checks. A registration never changes
   * after it is written, so caching it locally cannot go stale; it is also
   * persisted, so another instance can hydrate it.
   */
  private registeredClientsByClientId: Map<string, ProxyDCRClient> = new Map();
  private stateStore: OAuthProxyStateStore;
  private tokenStorage: TokenStorage;

  constructor(config: OAuthProxyConfig) {
    this.config = {
      authorizationCodeTtl: DEFAULT_AUTHORIZATION_CODE_TTL,
      consentRequired: true,
      enableTokenSwap: true, // Enabled by default for security
      redirectPath: "/oauth/callback",
      transactionTtl: DEFAULT_TRANSACTION_TTL,
      upstreamRequestTimeoutMs: DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS,
      upstreamTokenEndpointAuthMethod: "client_secret_basic",
      ...config,
      baseUrl: withoutTrailingSlash(config.baseUrl),
    };

    // Set up token storage with encryption by default (matches Python's secure defaults)
    let storage = config.tokenStorage;

    if (!storage) {
      this.ownedTokenStorage = new MemoryTokenStorage();
      storage = this.ownedTokenStorage;
    }

    // Wrap storage with encryption if not already encrypted
    // Check if it's already an EncryptedTokenStorage instance
    const isAlreadyEncrypted =
      storage.constructor.name === "EncryptedTokenStorage";

    if (!isAlreadyEncrypted && config.encryptionKey !== false) {
      // Auto-generate encryption key if not provided
      const encryptionKey =
        typeof config.encryptionKey === "string"
          ? config.encryptionKey
          : this.generateSigningKey();

      storage = new EncryptedTokenStorage(storage, encryptionKey);
    }

    this.tokenStorage = storage;
    this.clientIdMetadata = new ClientIdMetadataResolver(
      this.config.clientIdMetadata,
    );
    this.issuerNs = issuerNamespace(this.getUpstreamIssuer());
    this.stateStore = new OAuthProxyStateStore({
      issuer: this.getUpstreamIssuer(),
      registeredClientsByClientId: this.registeredClientsByClientId,
      tokenStorage: this.tokenStorage,
    });
    this.consentManager = new ConsentManager(
      config.consentSigningKey || this.generateSigningKey(),
    );

    // Initialize JWT issuer if token swap is enabled
    if (this.config.enableTokenSwap) {
      // Auto-generate signing key if not provided
      const signingKey = this.config.jwtSigningKey || this.generateSigningKey();

      this.jwtIssuer = new JWTIssuer({
        audience: this.config.baseUrl,
        issuer: this.config.baseUrl,
        signingKey: signingKey,
      });
    }

    // Initialize claims extractor (enabled by default)
    const claimsConfig =
      config.customClaimsPassthrough !== undefined
        ? config.customClaimsPassthrough
        : true; // Default: enabled

    if (claimsConfig !== false) {
      this.claimsExtractor = new ClaimsExtractor(claimsConfig);
    }

    // Start periodic cleanup
    this.startCleanup();
  }

  /**
   * OAuth authorization endpoint
   */
  async authorize(params: AuthorizationParams): Promise<Response> {
    // Validate parameters
    if (!params.client_id || !params.redirect_uri || !params.response_type) {
      throw new OAuthProxyError(
        "invalid_request",
        "Missing required parameters",
      );
    }

    if (params.response_type !== "code") {
      throw new OAuthProxyError(
        "unsupported_response_type",
        "Only 'code' response type is supported",
      );
    }

    // Two ways to be a known client: a URL-formatted client_id resolved as a
    // Client ID Metadata Document, or a proxy-issued id from DCR.
    const registeredClient = await this.resolveClient(params.client_id);
    const registeredUris = registeredClient.redirectUris;

    // RFC 6749 §3.1.2.3 / RFC 6819 §4.1.5 - the redirect_uri MUST be one
    // the client declared. Skipping this check is CWE-601: an attacker can
    // steal an authorization code by passing their own URL as redirect_uri.
    // A loopback declaration that omits the port matches any port (RFC 8252
    // §7.3); nothing else is relaxed.
    if (
      !registeredUris.some((uri) =>
        loopbackRedirectMatches(uri, params.redirect_uri),
      )
    ) {
      throw new OAuthProxyError(
        "invalid_request",
        "redirect_uri is not registered for this client",
      );
    }

    // Validate PKCE if provided
    if (params.code_challenge && !params.code_challenge_method) {
      throw new OAuthProxyError(
        "invalid_request",
        "code_challenge_method required when code_challenge is present",
      );
    }

    // Reject an unsupported method here rather than at /oauth/token. The token
    // endpoint treats an unknown method as a failed verifier check, which
    // surfaces as an `invalid_grant` after the user has already gone through
    // the upstream login — a confusing way to learn the method was never
    // supported. `plain` is unsupported unless `allowPlainPkce` is set.
    if (
      params.code_challenge &&
      params.code_challenge_method &&
      !this.supportedCodeChallengeMethods().includes(
        params.code_challenge_method,
      )
    ) {
      throw new OAuthProxyError(
        "invalid_request",
        `Unsupported code_challenge_method: ${params.code_challenge_method}`,
      );
    }

    // A public client — resolved from a metadata document, or registered with
    // token_endpoint_auth_method "none" — holds no secret, so PKCE is the only
    // thing binding the authorization code to whoever asked for it. `plain`
    // puts the verifier in the same request as the challenge, which binds
    // nothing, so S256 is required whatever `allowPlainPkce` says: that exists
    // for clients that cannot hash, and none of these is among them. OAuth 2.1
    // and the MCP authorization spec both require this of public clients.
    if (isPublicClient(registeredClient)) {
      const kind = describeUnauthenticatedClient(registeredClient);

      if (!params.code_challenge) {
        throw new OAuthProxyError(
          "invalid_request",
          `code_challenge is required for ${kind}`,
        );
      }

      if (params.code_challenge_method !== "S256") {
        throw new OAuthProxyError(
          "invalid_request",
          `code_challenge_method must be S256 for ${kind}`,
        );
      }
    }

    // Create transaction
    const transaction = await this.createTransaction(params);

    // If consent required, show consent screen
    if (this.config.consentRequired && !transaction.consentGiven) {
      return this.consentManager.createConsentResponse(
        transaction,
        this.getProviderName(),
      );
    }

    // Redirect to upstream provider
    return this.redirectToUpstream(transaction);
  }

  /**
   * Stop cleanup interval and destroy resources
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Only the storage this proxy created for itself; a caller-supplied one is
    // theirs to destroy.
    this.ownedTokenStorage?.destroy();

    this.registeredClientsByClientId.clear();
  }

  /**
   * Token endpoint - exchange authorization code for tokens
   */
  async exchangeAuthorizationCode(
    request: TokenRequest,
  ): Promise<TokenResponse> {
    if (request.grant_type !== "authorization_code") {
      throw new OAuthProxyError(
        "unsupported_grant_type",
        "Only authorization_code grant type is supported",
      );
    }

    // RFC 6749 §3.2.1 - identify the client and check its secret before the
    // code is touched: a caller that fails authentication must not be able to
    // spend a code it presents. Only proxy-issued client_ids (obtained via
    // DCR) and, when enabled, resolved CIMD clients are accepted.
    const { authenticated, client } = await this.authenticateClient(request);

    // Consume the code atomically: whoever takes it owns this exchange, so two
    // concurrent requests — on this instance or another one sharing the
    // storage — cannot both redeem it (RFC 6749 §4.1.2).
    const consumed = await this.stateStore.consumeClientCode(request.code);
    if (!consumed) {
      throw new OAuthProxyError(
        "invalid_grant",
        "Invalid or expired authorization code",
      );
    }

    // Put a tombstone back — whether the code was live or already spent — so
    // later attempts get the precise "already used" error rather than looking
    // like an unknown code. It replaces the record instead of amending it, so
    // the upstream tokens stop being stored the moment they are handed over,
    // and a spent code can never be resurrected.
    await this.stateStore.markClientCodeSpent(request.code, consumed.expiresAt);

    if (consumed.status === "spent") {
      throw new OAuthProxyError(
        "invalid_grant",
        "Authorization code already used",
      );
    }

    const clientCode = consumed.clientCode;

    // RFC 6749 §5.2: a code issued to another client is an invalid grant. The
    // caller authenticated as itself, so this is not a client failure — and
    // the code stays spent: presented by the wrong client, it has leaked.
    if (clientCode.clientId !== client.clientId) {
      throw new OAuthProxyError(
        "invalid_grant",
        "Authorization code was issued to another client",
      );
    }

    // Without client authentication, PKCE is all that binds the code to
    // whoever asked for it, so an unauthenticated exchange must redeem an
    // S256-bound code. `authorize()` already insists on that from public
    // clients, so for them this is defence in depth against a code issued
    // under other rules — by an older version, or by an instance sharing this
    // storage. For a registration that predates recorded auth methods it is
    // the rule itself: such a client may leave out its secret only for a code
    // PKCE protects.
    if (
      !authenticated &&
      (!clientCode.codeChallenge || clientCode.codeChallengeMethod !== "S256")
    ) {
      throw new OAuthProxyError(
        "invalid_grant",
        `S256 PKCE is required for ${describeUnauthenticatedClient(client)}`,
      );
    }

    // Validate PKCE if used
    if (clientCode.codeChallenge) {
      if (!request.code_verifier) {
        throw new OAuthProxyError(
          "invalid_request",
          "code_verifier required for PKCE",
        );
      }

      const valid = PKCEUtils.validateChallenge(
        request.code_verifier,
        clientCode.codeChallenge,
        clientCode.codeChallengeMethod,
      );

      if (!valid) {
        throw new OAuthProxyError("invalid_grant", "Invalid PKCE verifier");
      }
    }

    // Return tokens based on token swap setting
    if (this.config.enableTokenSwap && this.jwtIssuer) {
      // Token swap pattern: issue short-lived JWTs and store upstream tokens
      return await this.issueSwappedTokens(
        clientCode.clientId,
        clientCode.upstreamTokens,
        authenticated,
      );
    } else {
      // Pass-through pattern: return upstream tokens directly
      const response: TokenResponse = {
        access_token: clientCode.upstreamTokens.accessToken,
        expires_in: clientCode.upstreamTokens.expiresIn,
        token_type: clientCode.upstreamTokens.tokenType,
      };

      if (clientCode.upstreamTokens.refreshToken) {
        await this.savePassthroughRefreshBinding(
          clientCode.upstreamTokens.refreshToken,
          { clientAuthenticated: authenticated, clientId: client.clientId },
          clientCode.upstreamTokens.refreshExpiresIn,
        );

        response.refresh_token = clientCode.upstreamTokens.refreshToken;
      }

      if (clientCode.upstreamTokens.idToken) {
        response.id_token = clientCode.upstreamTokens.idToken;
      }

      if (clientCode.upstreamTokens.scope.length > 0) {
        response.scope = clientCode.upstreamTokens.scope.join(" ");
      }

      return response;
    }
  }

  /**
   * Token endpoint - refresh access token
   */
  async exchangeRefreshToken(request: RefreshRequest): Promise<TokenResponse> {
    if (request.grant_type !== "refresh_token") {
      throw new OAuthProxyError(
        "unsupported_grant_type",
        "Only refresh_token grant type is supported",
      );
    }

    // RFC 6749 §6: authenticate the client, then make sure the refresh token
    // was issued to it. Done before the token is looked at, so a caller that
    // fails authentication learns nothing about it and cannot spend it.
    const caller = await this.authenticateClient(request);

    // Check for swap mode
    if (this.config.enableTokenSwap && this.jwtIssuer) {
      return await this.handleSwapModeRefresh(request, caller);
    }

    // Passthrough mode: forward refresh token directly to upstream
    return await this.handlePassthroughRefresh(request, caller);
  }

  /**
   * Get OAuth discovery metadata
   */
  getAuthorizationServerMetadata(): {
    authorizationEndpoint: string;
    authorizationResponseIssParameterSupported?: boolean;
    clientIdMetadataDocumentSupported?: boolean;
    codeChallengeMethodsSupported?: string[];
    dpopSigningAlgValuesSupported?: string[];
    grantTypesSupported?: string[];
    introspectionEndpoint?: string;
    issuer: string;
    jwksUri?: string;
    opPolicyUri?: string;
    opTosUri?: string;
    registrationEndpoint?: string;
    responseModesSupported?: string[];
    responseTypesSupported: string[];
    revocationEndpoint?: string;
    scopesSupported?: string[];
    serviceDocumentation?: string;
    tokenEndpoint: string;
    tokenEndpointAuthMethodsSupported?: string[];
    tokenEndpointAuthSigningAlgValuesSupported?: string[];
    uiLocalesSupported?: string[];
  } {
    return {
      authorizationEndpoint: `${this.config.baseUrl}/oauth/authorize`,
      // RFC 9207 §3: advertise that responses carry `iss`, so clients know to
      // validate it.
      authorizationResponseIssParameterSupported: true,
      // Clients prefer CIMD over DCR when both are offered.
      clientIdMetadataDocumentSupported: this.clientIdMetadata.enabled,
      codeChallengeMethodsSupported: this.supportedCodeChallengeMethods(),
      grantTypesSupported: ["authorization_code", "refresh_token"],
      issuer: this.config.baseUrl,
      registrationEndpoint: `${this.config.baseUrl}/oauth/register`,
      responseTypesSupported: ["code"],
      scopesSupported: this.config.scopes || [],
      tokenEndpoint: `${this.config.baseUrl}/oauth/token`,
      // RFC 8414 §2. "none" is a public client: a CIMD client, which has no
      // registration response to carry a secret, or a DCR client that asked
      // for no secret. Either authenticates the exchange with S256 PKCE alone.
      // A client that reads this list to pick an auth method finds nothing it
      // can use unless "none" is advertised alongside the confidential methods.
      tokenEndpointAuthMethodsSupported: [...TOKEN_ENDPOINT_AUTH_METHODS],
    };
  }

  /**
   * Handle OAuth callback from upstream provider
   */
  async handleCallback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    // Check for errors from upstream
    if (error) {
      const errorDescription = url.searchParams.get("error_description");
      throw new OAuthProxyError(error, errorDescription || undefined);
    }

    if (!code || !state) {
      throw new OAuthProxyError(
        "invalid_request",
        "Missing code or state parameter",
      );
    }

    // Consume the transaction: a callback is single-use, so taking it here
    // prevents the same state from being replayed against this or any other
    // instance sharing the storage.
    const transaction = await this.stateStore.consumeTransaction(state);
    if (!transaction) {
      throw new OAuthProxyError("invalid_request", "Invalid or expired state");
    }

    // Defense-in-depth: the transaction's stored callback URL must still be
    // registered. Guards against any code path that could persist an
    // unvalidated URI, and against registration being revoked mid-flow.
    if (!(await this.isTransactionCallbackRegistered(transaction))) {
      throw new OAuthProxyError(
        "invalid_request",
        "Transaction callback URL is not registered",
      );
    }

    // RFC 9207 / SEP-2468: when the authorization response carries `iss`, it
    // MUST match the issuer this transaction was started against, and the code
    // MUST NOT be redeemed otherwise. This is what defeats a mix-up attack, in
    // which a malicious AS returns a code minted by a different one.
    const responseIssuer = url.searchParams.get("iss");

    if (responseIssuer && responseIssuer !== transaction.upstreamIssuer) {
      throw new OAuthProxyError(
        "invalid_request",
        "Authorization response issuer does not match the request issuer",
      );
    }

    // Exchange code with upstream provider
    const upstreamTokens = await this.exchangeUpstreamCode(code, transaction);

    // Generate authorization code for client
    const clientCode = await this.generateAuthorizationCode(
      transaction,
      upstreamTokens,
    );

    // Redirect to client callback with code
    const redirectUrl = new URL(transaction.clientCallbackUrl);
    redirectUrl.searchParams.set("code", clientCode);
    redirectUrl.searchParams.set("state", transaction.state);
    // RFC 9207 §2: identify the issuer so the client can detect an AS mix-up.
    redirectUrl.searchParams.set("iss", this.config.baseUrl);

    return new Response(null, {
      headers: {
        Location: redirectUrl.toString(),
      },
      status: 302,
    });
  }

  /**
   * Handle consent form submission
   */
  async handleConsent(request: Request): Promise<Response> {
    const formData = await request.formData();
    const transactionId = formData.get("transaction_id");
    const action = formData.get("action");

    if (typeof transactionId !== "string" || !transactionId) {
      throw new OAuthProxyError("invalid_request", "Missing transaction_id");
    }

    // Require the choice to be explicit. Anything else used to fall through to
    // the approve branch, so a submission that lost the field — or never sent
    // one — granted access the user never clicked for.
    if (action !== "approve" && action !== "deny") {
      throw new OAuthProxyError(
        "invalid_request",
        "action must be 'approve' or 'deny'",
      );
    }

    const transaction = await this.stateStore.getTransaction(transactionId);
    if (!transaction) {
      throw new OAuthProxyError(
        "invalid_request",
        "Invalid or expired transaction",
      );
    }

    if (action === "deny") {
      // User denied consent
      await this.stateStore.deleteTransaction(transactionId);
      // Defense-in-depth: never redirect to an unregistered URI.
      if (!(await this.isTransactionCallbackRegistered(transaction))) {
        throw new OAuthProxyError(
          "invalid_request",
          "Transaction callback URL is not registered",
        );
      }
      const redirectUrl = new URL(transaction.clientCallbackUrl);
      redirectUrl.searchParams.set("error", "access_denied");
      redirectUrl.searchParams.set(
        "error_description",
        "User denied authorization",
      );
      redirectUrl.searchParams.set("state", transaction.state);
      redirectUrl.searchParams.set("iss", this.config.baseUrl);

      return new Response(null, {
        headers: {
          Location: redirectUrl.toString(),
        },
        status: 302,
      });
    }

    // User approved, mark consent and redirect to upstream
    const approvedTransaction = {
      ...transaction,
      consentGiven: true,
    };
    await this.stateStore.saveTransaction(approvedTransaction);

    return this.redirectToUpstream(approvedTransaction);
  }

  /**
   * Load upstream tokens from a ViteMCP JWT
   */
  async loadUpstreamTokens(
    vitemcpToken: string,
  ): Promise<null | UpstreamTokenSet> {
    if (!this.jwtIssuer) {
      return null;
    }

    // Verify ViteMCP JWT
    const result = await this.jwtIssuer.verify(vitemcpToken);
    if (!result.valid || !result.claims?.jti) {
      return null;
    }

    // Only an access token is a bearer credential. A refresh token has a
    // mapping of its own, so without this check it would authenticate a
    // request too.
    if (result.claims.token_use !== "access") {
      return null;
    }

    // Look up token mapping
    const mapping = (await this.tokenStorage.get(
      `mapping:${this.issuerNs}:${result.claims.jti}`,
    )) as {
      upstreamTokenKey: string;
    } | null;

    if (!mapping) {
      return null;
    }

    // Retrieve upstream tokens
    const upstreamTokens = (await this.tokenStorage.get(
      `upstream:${this.issuerNs}:${mapping.upstreamTokenKey}`,
    )) as null | UpstreamTokenSet;

    return upstreamTokens;
  }

  /**
   * RFC 7591 Dynamic Client Registration
   */
  async registerClient(request: DCRRequest): Promise<DCRResponse> {
    // Validate required fields
    if (!request.redirect_uris || request.redirect_uris.length === 0) {
      throw new OAuthProxyError(
        "invalid_client_metadata",
        "redirect_uris is required",
      );
    }

    // Validate redirect URIs
    for (const uri of request.redirect_uris) {
      if (!this.validateRedirectUri(uri)) {
        throw new OAuthProxyError(
          "invalid_redirect_uri",
          `Invalid redirect URI: ${uri}`,
        );
      }
    }

    // Generate proxy-specific credentials for this MCP client.
    // We deliberately do NOT return the upstream provider's client_id/secret here:
    // exposing those would (a) leak credentials to every MCP client and (b) let a
    // client bypass the proxy and talk directly to the upstream provider.
    // SEP-837: clients specify how they are deployed so OpenID-aware servers
    // apply the right redirect-URI rules. Inferred from the redirect URIs when
    // omitted, rather than rejected, so existing clients keep working.
    const applicationType =
      request.application_type ??
      (request.redirect_uris.every((uri) => isLoopbackRedirectUri(uri))
        ? ("native" as const)
        : ("web" as const));

    if (
      request.application_type &&
      request.application_type !== "native" &&
      request.application_type !== "web"
    ) {
      throw new OAuthProxyError(
        "invalid_client_metadata",
        'application_type must be "native" or "web"',
      );
    }

    // RFC 7591 §2: the default is client_secret_basic. Recorded, because it
    // decides what the token endpoint demands of this client. A method the
    // token endpoint cannot verify is refused here rather than accepted and
    // then never checked.
    const tokenEndpointAuthMethod =
      request.token_endpoint_auth_method || "client_secret_basic";

    if (!isTokenEndpointAuthMethod(tokenEndpointAuthMethod)) {
      throw new OAuthProxyError(
        "invalid_client_metadata",
        `Unsupported token_endpoint_auth_method: ${tokenEndpointAuthMethod}. Supported: ${TOKEN_ENDPOINT_AUTH_METHODS.join(", ")}`,
      );
    }

    const proxyClientId = randomBytes(16).toString("hex");
    // A public client is issued no secret: it could not keep one, and one it
    // was never meant to use would only be mistaken for an authenticator.
    const proxyClientSecret =
      tokenEndpointAuthMethod === "none"
        ? undefined
        : randomBytes(32).toString("base64url");

    const client: ProxyDCRClient = {
      callbackUrl: request.redirect_uris[0],
      clientId: proxyClientId,
      clientSecret: proxyClientSecret,
      metadata: {
        application_type: request.application_type,
        client_name: request.client_name,
        client_uri: request.client_uri,
        contacts: request.contacts,
        jwks: request.jwks,
        jwks_uri: request.jwks_uri,
        logo_uri: request.logo_uri,
        policy_uri: request.policy_uri,
        scope: request.scope,
        software_id: request.software_id,
        software_version: request.software_version,
        tos_uri: request.tos_uri,
      },
      redirectUris: request.redirect_uris,
      registeredAt: new Date(),
      tokenEndpointAuthMethod,
    };

    // Persisted before it is cached: a write that fails must not leave behind
    // a client this instance honours and no other instance has heard of.
    await this.stateStore.saveRegisteredClient(client);
    this.stateStore.cacheRegisteredClient(client);

    // Return RFC 7591 compliant response with proxy-issued credentials.
    const response: DCRResponse = {
      // Echoed so a client can detect a server that silently dropped it.
      application_type: applicationType,
      client_id: proxyClientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // Echo back optional metadata
      client_name: request.client_name,
      client_secret: proxyClientSecret,
      // RFC 7591 §3.2.1: required alongside a secret, and only then.
      client_secret_expires_at: proxyClientSecret ? 0 : undefined, // 0: never
      client_uri: request.client_uri,
      contacts: request.contacts,
      grant_types: request.grant_types || [
        "authorization_code",
        "refresh_token",
      ],
      jwks: request.jwks,
      jwks_uri: request.jwks_uri,
      logo_uri: request.logo_uri,
      policy_uri: request.policy_uri,
      redirect_uris: request.redirect_uris,
      response_types: request.response_types || ["code"],
      scope: request.scope,
      software_id: request.software_id,
      software_version: request.software_version,
      token_endpoint_auth_method: tokenEndpointAuthMethod,
      tos_uri: request.tos_uri,
    };

    return response;
  }

  /**
   * RFC 6749 §2.3 / §3.2.1: identify the client behind a token request and,
   * when it presents a secret, authenticate it.
   *
   * A client registered with a secret method must present its secret. A
   * public client must not present one: it was issued none. A registration
   * that predates recorded auth methods may do either — it was issued a
   * secret whatever it asked for — and is treated as unauthenticated when it
   * leaves it out, which the grants then hold it to.
   *
   * Throws `invalid_client` on any failure. Nothing here touches grant state,
   * so a caller that fails cannot spend a code or refresh token.
   */
  private async authenticateClient(request: {
    client_id?: string;
    client_secret?: string;
  }): Promise<TokenEndpointClient> {
    if (!request.client_id) {
      throw new OAuthProxyError("invalid_client", "client_id is required");
    }

    const client = await this.resolveClient(request.client_id);

    // An empty secret identifies rather than authenticates: it is how a public
    // client sends HTTP Basic (`client_id:`).
    if (request.client_secret) {
      if (
        !client.clientSecret ||
        !secretsMatch(request.client_secret, client.clientSecret)
      ) {
        throw new OAuthProxyError(
          "invalid_client",
          "Client authentication failed",
        );
      }

      return { authenticated: true, client };
    }

    if (
      client.tokenEndpointAuthMethod === "client_secret_basic" ||
      client.tokenEndpointAuthMethod === "client_secret_post"
    ) {
      throw new OAuthProxyError(
        "invalid_client",
        "Client authentication failed: client_secret is required",
      );
    }

    return { authenticated: false, client };
  }

  /**
   * Calculate access token TTL from upstream tokens
   */
  private calculateAccessTokenTtl(upstreamTokens: UpstreamTokenSet): number {
    if (upstreamTokens.expiresIn > 0) {
      return upstreamTokens.expiresIn;
    } else if (this.config.accessTokenTtl) {
      return this.config.accessTokenTtl;
    } else if (upstreamTokens.refreshToken) {
      return DEFAULT_ACCESS_TOKEN_TTL;
    } else {
      return DEFAULT_ACCESS_TOKEN_TTL_NO_REFRESH;
    }
  }

  /**
   * Periodic maintenance hook. Expiry is enforced by the token storage.
   */
  private cleanup(): void {
    // Transactions and codes live in the token storage with a TTL derived from
    // their expiry, so sweeping them is the storage's job. Failures here must
    // not become unhandled rejections: this runs on a timer, and a transient
    // backend error would otherwise take the process down.
    void this.tokenStorage.cleanup().catch((error: unknown) => {
      console.error(
        "[ViteMCP] OAuth proxy token storage cleanup failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  /**
   * Create a new OAuth transaction
   */
  private async createTransaction(
    params: AuthorizationParams,
  ): Promise<OAuthTransaction> {
    const transactionId = this.generateId();
    const proxyPkce = PKCEUtils.generatePair("S256");

    const transaction: OAuthTransaction = {
      clientCallbackUrl: params.redirect_uri,
      clientCodeChallenge: params.code_challenge || "",
      clientCodeChallengeMethod: params.code_challenge_method || "plain",
      clientId: params.client_id,
      createdAt: new Date(),
      expiresAt: new Date(
        Date.now() + (this.config.transactionTtl || 600) * 1000,
      ),
      id: transactionId,
      proxyCodeChallenge: proxyPkce.challenge,
      proxyCodeVerifier: proxyPkce.verifier,
      scope: params.scope ? params.scope.split(" ") : this.config.scopes || [],
      state: params.state || this.generateId(),
      upstreamIssuer: this.getUpstreamIssuer(),
    };

    await this.stateStore.saveTransaction(transaction);

    return transaction;
  }

  /**
   * Exchange authorization code with upstream provider
   */
  private async exchangeUpstreamCode(
    code: string,
    transaction: OAuthTransaction,
  ): Promise<UpstreamTokenSet> {
    const useBasicAuth =
      this.config.upstreamTokenEndpointAuthMethod === "client_secret_basic";

    const bodyParams: Record<string, string> = {
      code,
      code_verifier: transaction.proxyCodeVerifier,
      grant_type: "authorization_code",
      redirect_uri: `${this.config.baseUrl}${this.config.redirectPath}`,
    };

    // Include client credentials in body only for client_secret_post
    if (!useBasicAuth) {
      bodyParams.client_id = this.config.upstreamClientId;
      bodyParams.client_secret = this.config.upstreamClientSecret;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // Add Basic Auth header for client_secret_basic
    if (useBasicAuth) {
      headers["Authorization"] = this.getBasicAuthHeader();
    }

    const tokenResponse = await this.fetchUpstream(bodyParams, headers);

    if (!tokenResponse.ok) {
      let errorCode = "server_error";
      let errorDescription: string | undefined;
      try {
        const error = (await tokenResponse.json()) as {
          error?: string;
          error_description?: string;
        };
        errorCode = error.error || "server_error";
        errorDescription = error.error_description;
      } catch {
        errorDescription = `Upstream returned HTTP ${tokenResponse.status} ${tokenResponse.statusText}`;
      }
      throw new OAuthProxyError(errorCode, errorDescription);
    }

    const tokens = await this.parseTokenResponse(tokenResponse);

    return {
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in || 3600,
      idToken: tokens.id_token,
      issuedAt: new Date(),
      refreshExpiresIn: tokens.refresh_expires_in,
      refreshToken: tokens.refresh_token,
      scope: tokens.scope ? tokens.scope.split(" ") : transaction.scope,
      tokenType: tokens.token_type || "Bearer",
    };
  }

  /**
   * Extract JTI from a JWT token
   */
  private async extractJti(token: string): Promise<string> {
    if (!this.jwtIssuer) {
      throw new Error("JWT issuer not initialized");
    }

    const result = await this.jwtIssuer.verify(token);
    if (!result.valid || !result.claims?.jti) {
      throw new Error("Failed to extract JTI from token");
    }

    return result.claims.jti;
  }

  /**
   * Extract custom claims from upstream tokens
   * Combines claims from access token and ID token (if present)
   */
  private async extractUpstreamClaims(
    upstreamTokens: UpstreamTokenSet,
  ): Promise<null | Record<string, unknown>> {
    if (!this.claimsExtractor) {
      return null;
    }

    const allClaims: Record<string, unknown> = {};

    // Extract from access token (if JWT format)
    const accessClaims = await this.claimsExtractor.extract(
      upstreamTokens.accessToken,
      "access",
    );
    if (accessClaims) {
      Object.assign(allClaims, accessClaims);
    }

    // Extract from ID token (if present and JWT format)
    if (upstreamTokens.idToken) {
      const idClaims = await this.claimsExtractor.extract(
        upstreamTokens.idToken,
        "id",
      );
      if (idClaims) {
        // Access token claims take precedence over ID token claims
        for (const [key, value] of Object.entries(idClaims)) {
          if (!(key in allClaims)) {
            allClaims[key] = value;
          }
        }
      }
    }

    return Object.keys(allClaims).length > 0 ? allClaims : null;
  }

  /**
   * POST to the upstream token endpoint with a bounded wait.
   *
   * Maps an abort of the configured timeout signal to a clean OAuth error
   * instead of letting the raw `TimeoutError`/`AbortError` propagate.
   */
  private async fetchUpstream(
    bodyParams: Record<string, string>,
    headers: Record<string, string>,
  ): Promise<Response> {
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(this.config.upstreamTokenEndpoint, {
        body: new URLSearchParams(bodyParams),
        headers,
        method: "POST",
        signal: AbortSignal.timeout(
          this.config.upstreamRequestTimeoutMs ??
            DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS,
        ),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new OAuthProxyError("server_error", "Upstream request timed out");
      }
      throw error;
    }
    return tokenResponse;
  }

  /**
   * Generate authorization code for client
   */
  private async generateAuthorizationCode(
    transaction: OAuthTransaction,
    upstreamTokens: UpstreamTokenSet,
  ): Promise<string> {
    const code = this.generateId();

    const clientCode: ClientCode = {
      clientId: transaction.clientId,
      code,
      codeChallenge: transaction.clientCodeChallenge,
      codeChallengeMethod: transaction.clientCodeChallengeMethod,
      createdAt: new Date(),
      expiresAt: new Date(
        Date.now() + (this.config.authorizationCodeTtl || 300) * 1000,
      ),
      transactionId: transaction.id,
      upstreamTokens,
    };

    await this.stateStore.saveClientCode(clientCode);

    return code;
  }

  /**
   * Generate secure random ID
   */
  private generateId(): string {
    return randomBytes(32).toString("base64url");
  }

  /**
   * Generate signing key for consent cookies
   */
  private generateSigningKey(): string {
    return randomBytes(32).toString("hex");
  }

  /**
   * Generate Basic auth header value for upstream token endpoint
   * Per RFC 6749 Section 2.3.1, credentials must be URL-encoded before base64 encoding
   */
  private getBasicAuthHeader(): string {
    const encodedClientId = encodeURIComponent(this.config.upstreamClientId);
    const encodedClientSecret = encodeURIComponent(
      this.config.upstreamClientSecret,
    );
    return `Basic ${Buffer.from(`${encodedClientId}:${encodedClientSecret}`).toString("base64")}`;
  }

  /**
   * Get provider name for display
   */
  private getProviderName(): string {
    const url = new URL(this.config.upstreamAuthorizationEndpoint);
    return url.hostname;
  }

  /**
   * Issuer identifier of the upstream authorization server.
   *
   * Defaults to the origin of the configured authorization endpoint, which is
   * what RFC 8414 issuers look like in practice; override with
   * `upstreamIssuer` when the provider's issuer differs from its endpoint host
   * (e.g. a tenant-scoped path).
   */
  private getUpstreamIssuer(): string {
    if (this.config.upstreamIssuer) {
      return this.config.upstreamIssuer;
    }

    return new URL(this.config.upstreamAuthorizationEndpoint).origin;
  }

  /**
   * Handle passthrough mode refresh - forward refresh token directly to upstream
   */
  private async handlePassthroughRefresh(
    request: RefreshRequest,
    caller: TokenEndpointClient,
  ): Promise<TokenResponse> {
    // The upstream refresh token was issued to the proxy's own upstream
    // client, on behalf of every MCP client, so the upstream cannot tell whose
    // it is — and the proxy attaches its upstream credentials to whatever it
    // forwards. Client authentication alone would not help: anyone can
    // register a client. Only the record of which client this token went to
    // stops a stolen one being redeemed here.
    const bindingKey = this.passthroughRefreshKey(request.refresh_token);
    const binding = passthroughRefreshBindingSchema.safeParse(
      await this.tokenStorage.get(bindingKey),
    );

    if (!binding.success) {
      throw new OAuthProxyError(
        "invalid_grant",
        "Invalid or expired refresh token",
      );
    }

    if (binding.data.clientId !== caller.client.clientId) {
      throw new OAuthProxyError(
        "invalid_grant",
        "Refresh token was issued to another client",
      );
    }

    if (binding.data.clientAuthenticated && !caller.authenticated) {
      throw new OAuthProxyError(
        "invalid_client",
        "Client authentication failed: client_secret is required",
      );
    }

    const useBasicAuth =
      this.config.upstreamTokenEndpointAuthMethod === "client_secret_basic";

    const bodyParams: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: request.refresh_token,
      ...(request.scope && { scope: request.scope }),
    };

    // Include client credentials in body only for client_secret_post
    if (!useBasicAuth) {
      bodyParams.client_id = this.config.upstreamClientId;
      bodyParams.client_secret = this.config.upstreamClientSecret;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // Add Basic Auth header for client_secret_basic
    if (useBasicAuth) {
      headers["Authorization"] = this.getBasicAuthHeader();
    }

    // Exchange refresh token with upstream provider
    const tokenResponse = await this.fetchUpstream(bodyParams, headers);

    if (!tokenResponse.ok) {
      let errorCode = "invalid_grant";
      let errorDescription: string | undefined;
      try {
        const error = (await tokenResponse.json()) as {
          error?: string;
          error_description?: string;
        };
        errorCode = error.error || "invalid_grant";
        errorDescription = error.error_description;
      } catch {
        errorDescription = `Upstream returned HTTP ${tokenResponse.status} ${tokenResponse.statusText}`;
      }
      throw new OAuthProxyError(errorCode, errorDescription);
    }

    const tokens = await this.parseTokenResponse(tokenResponse);

    // The client goes on to use either the rotated token or, when the upstream
    // did not rotate, the one it already holds; bind whichever that is. A
    // fresh lifetime matches swap mode, where every refresh issues a new
    // refresh token with its own.
    await this.savePassthroughRefreshBinding(
      tokens.refresh_token || request.refresh_token,
      {
        clientAuthenticated: caller.authenticated,
        clientId: caller.client.clientId,
      },
      tokens.refresh_expires_in,
    );

    // Only once the new binding is written: a failure in between must not
    // leave the client holding a token the proxy no longer recognises.
    if (
      tokens.refresh_token &&
      tokens.refresh_token !== request.refresh_token
    ) {
      await this.tokenStorage.delete(bindingKey);
    }

    return {
      access_token: tokens.access_token,
      expires_in: tokens.expires_in || 3600,
      id_token: tokens.id_token,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
      token_type: tokens.token_type || "Bearer",
    };
  }

  /**
   * Handle swap mode refresh - verify ViteMCP JWT and issue new tokens
   */
  private async handleSwapModeRefresh(
    request: RefreshRequest,
    caller: TokenEndpointClient,
  ): Promise<TokenResponse> {
    if (!this.jwtIssuer) {
      throw new Error("JWT issuer not initialized");
    }

    const verifyResult = await this.jwtIssuer.verify(request.refresh_token);
    if (!verifyResult.valid || !verifyResult.claims) {
      throw new OAuthProxyError(
        "invalid_grant",
        "Invalid or expired refresh token",
      );
    }

    // An access token verifies under the same key and has a mapping of its
    // own, so without this a one-hour bearer token could be swapped for a
    // refresh token. Tokens issued before `token_use` existed carry neither
    // value and are refused, so their holders sign in again.
    if (verifyResult.claims.token_use !== "refresh") {
      throw new OAuthProxyError("invalid_grant", "Not a refresh token");
    }

    const jti = verifyResult.claims.jti;
    if (!jti) {
      throw new OAuthProxyError("invalid_grant", "Refresh token missing JTI");
    }

    // RFC 6749 §6: the token must have been issued to the client presenting
    // it. Checked against the signed claim before the mapping is claimed, so
    // another client presenting a stolen token cannot spend it either.
    if (verifyResult.claims.client_id !== caller.client.clientId) {
      throw new OAuthProxyError(
        "invalid_grant",
        "Refresh token was issued to another client",
      );
    }

    // Claim the mapping atomically: whoever takes it owns this rotation, so two
    // concurrent refreshes — on this instance or another one sharing the
    // storage — cannot both redeem the same single-use refresh token.
    const mapping = (await this.takeMapping(jti)) as {
      clientAuthenticated?: boolean;
      clientId: string;
      expiresAt?: Date | string;
      scope: string[];
      upstreamTokenKey: string;
    } | null;

    if (!mapping) {
      throw new OAuthProxyError(
        "invalid_grant",
        "Refresh token already used or expired",
      );
    }

    try {
      // Defence in depth: the mapping is the proxy's own record of the holder.
      if (mapping.clientId !== caller.client.clientId) {
        throw new OAuthProxyError(
          "invalid_grant",
          "Refresh token was issued to another client",
        );
      }

      // A token issued to a client that authenticated is only redeemed by one
      // that does, or leaving out the secret would turn it back into a bearer
      // token. Only an explicit `false` waives it.
      if (mapping.clientAuthenticated !== false && !caller.authenticated) {
        throw new OAuthProxyError(
          "invalid_client",
          "Client authentication failed: client_secret is required",
        );
      }

      const upstreamTokens = (await this.tokenStorage.get(
        `upstream:${this.issuerNs}:${mapping.upstreamTokenKey}`,
      )) as null | UpstreamTokenSet;

      if (!upstreamTokens) {
        throw new OAuthProxyError(
          "invalid_grant",
          "Upstream tokens not found or expired",
        );
      }

      if (!upstreamTokens.refreshToken) {
        throw new OAuthProxyError(
          "invalid_grant",
          "No upstream refresh token available",
        );
      }

      const refreshedUpstreamTokens = await this.refreshUpstreamTokens(
        upstreamTokens.refreshToken,
        request.scope,
      );

      if (refreshedUpstreamTokens.scope.length === 0) {
        refreshedUpstreamTokens.scope = upstreamTokens.scope;
      }

      const refreshTokenTtl =
        refreshedUpstreamTokens.refreshExpiresIn ??
        this.config.refreshTokenTtl ??
        DEFAULT_REFRESH_TOKEN_TTL;
      const accessTokenTtl = this.calculateAccessTokenTtl(
        refreshedUpstreamTokens,
      );
      const upstreamStorageTtl = Math.max(accessTokenTtl, refreshTokenTtl, 1);

      await this.tokenStorage.save(
        `upstream:${this.issuerNs}:${mapping.upstreamTokenKey}`,
        refreshedUpstreamTokens,
        upstreamStorageTtl,
      );

      return await this.issueSwappedTokensForRefresh(
        mapping.clientId,
        refreshedUpstreamTokens,
        mapping.upstreamTokenKey,
        caller.authenticated,
      );
    } catch (error) {
      // No tokens reached the client, so hand the refresh token back rather
      // than logging the user out over a transient upstream failure — or over
      // a caller that failed the checks above, which must not be able to spend
      // a token it could not redeem. Restoring cannot allow a double
      // redemption: any concurrent attempt was already rejected, and a
      // rotation that throws returns nothing the caller can use, even when it
      // failed partway through issuance.
      try {
        await this.restoreMapping(jti, mapping);
      } catch (restoreError) {
        // Surface the failure that actually broke the refresh, not this one.
        console.error(
          `Failed to restore refresh token mapping ${jti}:`,
          restoreError,
        );
      }

      throw error;
    }
  }

  /**
   * Issue swapped tokens (JWT pattern)
   * Issues short-lived ViteMCP JWTs and stores upstream tokens securely
   */
  private async issueSwappedTokens(
    clientId: string,
    upstreamTokens: UpstreamTokenSet,
    clientAuthenticated: boolean,
  ): Promise<TokenResponse> {
    if (!this.jwtIssuer) {
      throw new Error("JWT issuer not initialized");
    }

    // Extract custom claims from upstream tokens
    const customClaims = await this.extractUpstreamClaims(upstreamTokens);

    // Determine access token TTL (hierarchical: upstream → config → default)
    let accessTokenTtl: number;
    if (upstreamTokens.expiresIn > 0) {
      accessTokenTtl = upstreamTokens.expiresIn;
    } else if (this.config.accessTokenTtl) {
      accessTokenTtl = this.config.accessTokenTtl;
    } else if (upstreamTokens.refreshToken) {
      accessTokenTtl = DEFAULT_ACCESS_TOKEN_TTL;
    } else {
      accessTokenTtl = DEFAULT_ACCESS_TOKEN_TTL_NO_REFRESH;
    }

    // Determine refresh token TTL early (needed for upstream storage TTL)
    // Use upstream's refresh_expires_in if provided, otherwise fall back to config/default
    const refreshTokenTtl = upstreamTokens.refreshToken
      ? (upstreamTokens.refreshExpiresIn ??
        this.config.refreshTokenTtl ??
        DEFAULT_REFRESH_TOKEN_TTL)
      : 0;

    // Store upstream tokens with longest-lived token TTL (min 1s for safety)
    const upstreamStorageTtl = Math.max(accessTokenTtl, refreshTokenTtl, 1);
    const upstreamTokenKey = this.generateId();
    await this.tokenStorage.save(
      `upstream:${this.issuerNs}:${upstreamTokenKey}`,
      upstreamTokens,
      upstreamStorageTtl,
    );

    // Issue ViteMCP access token with custom claims
    const accessToken = this.jwtIssuer.issueAccessToken(
      clientId,
      upstreamTokens.scope,
      customClaims || undefined,
      accessTokenTtl,
    );

    // Decode JWT to get JTI
    const accessJti = await this.extractJti(accessToken);

    // Store token mapping
    await this.tokenStorage.save(
      `mapping:${this.issuerNs}:${accessJti}`,
      {
        clientId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + accessTokenTtl * 1000),
        jti: accessJti,
        scope: upstreamTokens.scope,
        upstreamTokenKey,
      },
      accessTokenTtl,
    );

    const response: TokenResponse = {
      access_token: accessToken,
      expires_in: accessTokenTtl,
      scope: upstreamTokens.scope.join(" "),
      token_type: "Bearer",
    };

    // Issue refresh token if upstream provided one
    if (upstreamTokens.refreshToken) {
      const refreshToken = this.jwtIssuer.issueRefreshToken(
        clientId,
        upstreamTokens.scope,
        customClaims || undefined,
        refreshTokenTtl,
      );
      const refreshJti = await this.extractJti(refreshToken);

      // Store refresh token mapping
      await this.tokenStorage.save(
        `mapping:${this.issuerNs}:${refreshJti}`,
        {
          clientAuthenticated,
          clientId,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + refreshTokenTtl * 1000),
          jti: refreshJti,
          scope: upstreamTokens.scope,
          upstreamTokenKey,
        },
        refreshTokenTtl,
      );

      response.refresh_token = refreshToken;
    }

    return response;
  }

  /**
   * Issue swapped tokens for refresh flow
   */
  private async issueSwappedTokensForRefresh(
    clientId: string,
    upstreamTokens: UpstreamTokenSet,
    upstreamTokenKey: string,
    clientAuthenticated: boolean,
  ): Promise<TokenResponse> {
    if (!this.jwtIssuer) {
      throw new Error("JWT issuer not initialized");
    }

    const customClaims = await this.extractUpstreamClaims(upstreamTokens);

    const accessTokenTtl = this.calculateAccessTokenTtl(upstreamTokens);
    const refreshTokenTtl = upstreamTokens.refreshToken
      ? (upstreamTokens.refreshExpiresIn ??
        this.config.refreshTokenTtl ??
        DEFAULT_REFRESH_TOKEN_TTL)
      : 0;

    const accessToken = this.jwtIssuer.issueAccessToken(
      clientId,
      upstreamTokens.scope,
      customClaims || undefined,
      accessTokenTtl,
    );

    const accessJti = await this.extractJti(accessToken);
    await this.tokenStorage.save(
      `mapping:${this.issuerNs}:${accessJti}`,
      {
        clientId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + accessTokenTtl * 1000),
        jti: accessJti,
        scope: upstreamTokens.scope,
        upstreamTokenKey,
      },
      accessTokenTtl,
    );

    const response: TokenResponse = {
      access_token: accessToken,
      expires_in: accessTokenTtl,
      scope: upstreamTokens.scope.join(" "),
      token_type: "Bearer",
    };

    if (upstreamTokens.refreshToken) {
      const refreshToken = this.jwtIssuer.issueRefreshToken(
        clientId,
        upstreamTokens.scope,
        customClaims || undefined,
        refreshTokenTtl,
      );
      const refreshJti = await this.extractJti(refreshToken);

      // A client that authenticated keeps having to: the flag only rises.
      // `handleSwapModeRefresh` refuses an unauthenticated caller when the
      // previous token was issued to an authenticated one.
      await this.tokenStorage.save(
        `mapping:${this.issuerNs}:${refreshJti}`,
        {
          clientAuthenticated,
          clientId,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + refreshTokenTtl * 1000),
          jti: refreshJti,
          scope: upstreamTokens.scope,
          upstreamTokenKey,
        },
        refreshTokenTtl,
      );

      response.refresh_token = refreshToken;
    }

    return response;
  }

  /**
   * Whether the callback URL a transaction carries is still one its client
   * declares.
   *
   * Resolved through `resolveClient` rather than a raw store lookup so a CIMD
   * client is visible here too, and so a document that has since dropped the
   * URI stops matching — the mid-flow revocation this check exists for.
   * Loopback ports are matched per RFC 8252 §7.3, exactly as `authorize()`
   * matched them, so the two legs cannot disagree about the same URI.
   */
  private async isTransactionCallbackRegistered(
    transaction: OAuthTransaction,
  ): Promise<boolean> {
    let client: ProxyDCRClient;

    try {
      client = await this.resolveClient(transaction.clientId);
    } catch {
      // An unknown or no-longer-resolvable client is not a registered one.
      return false;
    }

    return client.redirectUris.some((uri) =>
      loopbackRedirectMatches(uri, transaction.clientCallbackUrl),
    );
  }

  /**
   * Match a parsed URI against an allow-list pattern, one URI component at a
   * time: scheme, host, port, then everything from the path onwards. A `*`
   * therefore stops where its component stops.
   *
   * That containment is the whole point. Matching the pattern against the raw
   * string let a wildcard run straight through the delimiters that decide
   * where the browser actually navigates:
   *
   *   - `http://localhost:*` matched `http://localhost:@evil.com/cb`, where
   *     `localhost:` is userinfo and the real host is `evil.com`.
   *   - `https://*.example.com/*` matched
   *     `https://evil.com/a.example.com/cb`, because the wildcard covered
   *     `evil.com/a` — authority and path at once.
   *
   * Both register cleanly under the old matcher, and `handleCallback()` would
   * then 302 a fresh authorization code to the attacker's host: the CWE-601
   * theft path this allow-list exists to close. Comparing against `URL`'s
   * parse makes the delimiters structural rather than incidental, so no
   * pattern can span them however it is written.
   *
   * A pattern that omits the path (`http://localhost:*`, the loopback default)
   * constrains scheme, host and port only — an ephemeral client chooses its
   * own callback path. Write a path to pin one.
   */
  private matchesPattern(uri: URL, pattern: string): boolean {
    const parsed = parseUriPattern(pattern);

    if (!parsed) {
      return false;
    }

    // `URL` lower-cases both, so the comparisons below are case-insensitive
    // exactly where the URI syntax says they should be.
    if (uri.protocol.slice(0, -1) !== parsed.scheme) {
      return false;
    }

    if (parsed.authority) {
      if (!globComponent(parsed.authority.host).test(uri.hostname)) {
        return false;
      }

      // `port` is "" for a scheme's default port, so `*` covers both.
      if (!globComponent(parsed.authority.port).test(uri.port)) {
        return false;
      }
    } else if (uri.host !== "") {
      // Pattern is `scheme:path` with no authority; the URI has one.
      return false;
    }

    if (parsed.rest === "") {
      return true;
    }

    return globComponent(parsed.rest).test(
      `${uri.pathname}${uri.search}${uri.hash}`,
    );
  }

  /**
   * Parse token response that can be either JSON or URL-encoded
   * GitHub Apps return URL-encoded format, most providers return JSON
   */
  private async parseTokenResponse(response: Response): Promise<{
    access_token: string;
    expires_in?: number;
    id_token?: string;
    refresh_expires_in?: number;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
  }> {
    const contentType = (
      response.headers.get("content-type") || ""
    ).toLowerCase();

    // Define Zod schema for token response validation
    const tokenResponseSchema = z.object({
      access_token: z.string().min(1, "access_token cannot be empty"),
      expires_in: z.coerce.number().int().positive().optional(),
      id_token: z.string().optional(),
      refresh_expires_in: z.coerce.number().int().positive().optional(),
      refresh_token: z.string().optional(),
      scope: z.string().optional(),
      token_type: z.string().optional(),
    });

    // Check if response is URL-encoded (e.g., GitHub Apps)
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await response.text();
      const params = new URLSearchParams(text);

      this.rejectUpstreamError({
        error: params.get("error"),
        error_description: params.get("error_description"),
      });

      const rawData = {
        access_token: params.get("access_token") || "",
        expires_in: params.get("expires_in")
          ? parseInt(params.get("expires_in")!)
          : undefined,
        id_token: params.get("id_token") || undefined,
        refresh_expires_in: params.get("refresh_expires_in")
          ? parseInt(params.get("refresh_expires_in")!)
          : undefined,
        refresh_token: params.get("refresh_token") || undefined,
        scope: params.get("scope") || undefined,
        token_type: params.get("token_type") || undefined,
      };

      return tokenResponseSchema.parse(rawData);
    }

    // Default to JSON parsing
    const rawJson = await response.json();
    this.rejectUpstreamError(rawJson);
    return tokenResponseSchema.parse(rawJson);
  }

  /**
   * Storage key for the client binding of a passthrough-mode upstream refresh
   * token. Keyed by its hash: storage keys are not encrypted, and the token
   * itself is a live upstream credential.
   */
  private passthroughRefreshKey(refreshToken: string): string {
    const digest = createHash("sha256")
      .update(refreshToken)
      .digest("base64url");

    return `passthrough-refresh:${this.issuerNs}:${digest}`;
  }

  /**
   * Redirect to upstream OAuth provider
   */
  private redirectToUpstream(transaction: OAuthTransaction): Response {
    const authUrl = new URL(this.config.upstreamAuthorizationEndpoint);

    // Provider-specific extras (e.g. Google's access_type=offline) go first
    // so the proxy-controlled core parameters below always win on conflict.
    if (this.config.extraAuthorizationParams) {
      for (const [key, value] of Object.entries(
        this.config.extraAuthorizationParams,
      )) {
        if (!RESERVED_AUTHORIZATION_PARAMS.has(key)) {
          authUrl.searchParams.set(key, value);
        }
      }
    }

    authUrl.searchParams.set("client_id", this.config.upstreamClientId);
    authUrl.searchParams.set(
      "redirect_uri",
      `${this.config.baseUrl}${this.config.redirectPath}`,
    );
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state", transaction.id);

    if (transaction.scope.length > 0) {
      authUrl.searchParams.set("scope", transaction.scope.join(" "));
    }

    // Add PKCE if not forwarding client PKCE
    if (!this.config.forwardPkce) {
      authUrl.searchParams.set(
        "code_challenge",
        transaction.proxyCodeChallenge,
      );
      authUrl.searchParams.set("code_challenge_method", "S256");
    }

    return new Response(null, {
      headers: {
        Location: authUrl.toString(),
      },
      status: 302,
    });
  }

  /**
   * Refresh upstream tokens with provider
   */
  private async refreshUpstreamTokens(
    upstreamRefreshToken: string,
    requestedScope?: string,
  ): Promise<UpstreamTokenSet> {
    const useBasicAuth =
      this.config.upstreamTokenEndpointAuthMethod === "client_secret_basic";

    const bodyParams: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: upstreamRefreshToken,
      ...(requestedScope && { scope: requestedScope }),
    };

    // Include client credentials in body only for client_secret_post
    if (!useBasicAuth) {
      bodyParams.client_id = this.config.upstreamClientId;
      bodyParams.client_secret = this.config.upstreamClientSecret;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // Add Basic Auth header for client_secret_basic
    if (useBasicAuth) {
      headers["Authorization"] = this.getBasicAuthHeader();
    }

    // Exchange refresh token with upstream provider
    const tokenResponse = await this.fetchUpstream(bodyParams, headers);

    if (!tokenResponse.ok) {
      let errorCode = "invalid_grant";
      let errorDescription: string | undefined = "Upstream refresh failed";
      try {
        const error = (await tokenResponse.json()) as {
          error?: string;
          error_description?: string;
        };
        errorCode = error.error || "invalid_grant";
        errorDescription = error.error_description || "Upstream refresh failed";
      } catch {
        errorDescription = `Upstream returned HTTP ${tokenResponse.status} ${tokenResponse.statusText}`;
      }
      throw new OAuthProxyError(errorCode, errorDescription);
    }

    const tokens = await this.parseTokenResponse(tokenResponse);

    // Handle token rotation: if upstream doesn't return new refresh token,
    // preserve the original one
    return {
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in || 3600,
      idToken: tokens.id_token,
      issuedAt: new Date(),
      refreshExpiresIn: tokens.refresh_expires_in,
      refreshToken: tokens.refresh_token || upstreamRefreshToken,
      scope: tokens.scope ? tokens.scope.split(" ") : [],
      tokenType: tokens.token_type || "Bearer",
    };
  }

  /**
   * Throws the error a provider's token response reports, if it reports one.
   *
   * RFC 6749 §5.2 fixes the fields of a refusal, not the status that carries
   * it, and GitHub answers a refused token request with a 200. Read as a
   * token, that body failed the schema for want of an access token, and the
   * client was told its own request was malformed (`invalid_request`) instead
   * of what the provider refused. The provider's code and description are
   * passed on, as the non-2xx paths already do.
   */
  private rejectUpstreamError(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const { error, error_description } = payload as {
      error?: unknown;
      error_description?: unknown;
    };

    // A provider that issued a token leaves `error` out; empty is no error.
    if (typeof error !== "string" || error === "") {
      return;
    }

    throw new OAuthProxyError(
      error,
      typeof error_description === "string" ? error_description : undefined,
    );
  }

  /**
   * The client behind a client_id, on whichever leg of the flow asks.
   *
   * A URL-formatted client_id is resolved as a Client ID Metadata Document
   * (the preferred mechanism on this revision); anything else must have been
   * registered through DCR. Throws `invalid_client` when it is neither.
   */
  private async resolveClient(clientId: string): Promise<ProxyDCRClient> {
    // A proxy-issued id from DCR is authoritative: it was registered here.
    const registered =
      await this.stateStore.getRegisteredClientByClientId(clientId);

    if (registered) {
      return registered;
    }

    if (this.clientIdMetadata.enabled && isClientIdMetadataUrl(clientId)) {
      let metadata;

      try {
        metadata = await this.clientIdMetadata.resolve(clientId);
      } catch (error) {
        throw new OAuthProxyError(
          "invalid_client",
          error instanceof ClientIdMetadataError
            ? error.message
            : "Could not resolve client metadata",
        );
      }

      // The document is authored by whoever controls the client_id URL, so the
      // URIs in it are no more trusted than the ones a DCR request carries and
      // face the same allow-list. Returning them unchecked would let anyone
      // able to host an HTTPS file name their own callback and be handed the
      // authorization code — `allowedRedirectUriPatterns`, and the loopback
      // default, bypassed by presenting a URL as the client_id.
      for (const uri of metadata.redirect_uris) {
        if (!this.validateRedirectUri(uri)) {
          throw new OAuthProxyError(
            "invalid_client",
            `Client metadata declares a redirect URI that is not allowed: ${uri}`,
          );
        }
      }

      // Returned, never persisted. Writing the document into the registered
      // client store would freeze it: the DCR lookup above runs first, so the
      // document would never be read again, and `saveRegisteredClient` takes
      // no TTL. Removing a redirect URI from the document is how a CIMD client
      // revokes it, and that has to keep working. The resolver already caches
      // for as long as the document's own Cache-Control allows.
      return {
        callbackUrl: metadata.redirect_uris[0],
        clientId,
        clientSecret: undefined,
        metadata: {
          client_name: metadata.client_name,
          client_uri: metadata.client_uri,
          redirect_uris: metadata.redirect_uris,
        } as ProxyDCRClient["metadata"],
        redirectUris: metadata.redirect_uris,
        registeredAt: new Date(),
        source: "cimd",
      };
    }

    // RFC 6749 §5.2 - reject unknown clients with invalid_client. MCP clients
    // receive a proxy-issued client_id during DCR, so we look up by that.
    throw new OAuthProxyError("invalid_client", "Unknown client_id");
  }

  /**
   * Put a claimed refresh-token mapping back after a rotation failed, keeping
   * whatever lifetime it had left.
   *
   * A mapping that is already expired, or that carries no usable expiry, is
   * dropped instead. Inventing a TTL here would extend the lifetime of a
   * credential in a security path, and every mapping this proxy writes records
   * `expiresAt`.
   */
  private async restoreMapping(
    jti: string,
    mapping: { expiresAt?: Date | string },
  ): Promise<void> {
    if (!mapping.expiresAt) {
      return;
    }

    const expiresAt = new Date(mapping.expiresAt).getTime();

    if (Number.isNaN(expiresAt)) {
      return;
    }

    const ttl = Math.ceil((expiresAt - Date.now()) / 1000);

    if (ttl <= 0) {
      return;
    }

    await this.tokenStorage.save(
      `mapping:${this.issuerNs}:${jti}`,
      mapping,
      ttl,
    );
  }

  /**
   * Record which client a passthrough-mode upstream refresh token was handed
   * to. It lives as long as the upstream says the token does, or as the
   * configured refresh-token lifetime when it does not say.
   */
  private async savePassthroughRefreshBinding(
    refreshToken: string,
    binding: z.infer<typeof passthroughRefreshBindingSchema>,
    refreshExpiresIn: number | undefined,
  ): Promise<void> {
    await this.tokenStorage.save(
      this.passthroughRefreshKey(refreshToken),
      binding,
      refreshExpiresIn ??
        this.config.refreshTokenTtl ??
        DEFAULT_REFRESH_TOKEN_TTL,
    );
  }

  /**
   * Start periodic cleanup of expired transactions and codes
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Run every minute
  }

  /**
   * PKCE challenge methods this proxy accepts, advertised in the authorization
   * server metadata and enforced at /oauth/authorize.
   *
   * S256 only by default. `plain` makes the challenge and the verifier the same
   * value, so the secret needed to redeem an authorization code is exposed
   * everywhere the authorization request is: browser history, referrer headers,
   * proxy logs. RFC 7636 §4.2 requires S256 of any client that can hash, and
   * OAuth 2.1 removes `plain` entirely.
   */
  private supportedCodeChallengeMethods(): string[] {
    return this.config.allowPlainPkce ? ["S256", "plain"] : ["S256"];
  }

  /**
   * Atomically claim a token mapping, mirroring `OAuthProxyStateStore`: at most
   * one caller — across all processes sharing the storage — can receive a given
   * mapping, which is what makes single use enforceable. Falls back to a
   * non-atomic get + delete for storages that do not implement `take`.
   */
  private async takeMapping(jti: string): Promise<null | unknown> {
    const key = `mapping:${this.issuerNs}:${jti}`;

    if (this.tokenStorage.take) {
      return await this.tokenStorage.take(key);
    }

    const stored = await this.tokenStorage.get(key);

    if (stored === null) {
      return null;
    }

    await this.tokenStorage.delete(key);

    return stored;
  }

  /**
   * Validate a redirect URI against the configured allow-list.
   *
   * Behaviour by configuration value:
   *   - `undefined` (not set): allow localhost/127.0.0.1 only — safe default
   *     that covers the common MCP use-case of dynamic loopback ports without
   *     opening the proxy to arbitrary redirect URIs.
   *   - `[]` (empty array): reject every URI — opt-in strict mode for deployments
   *     that want full control and will configure patterns explicitly.
   *   - `["pattern", ...]`: accept URIs matching any of the glob patterns.
   *
   * Prior versions defaulted to `["https://*", "http://localhost:*"]` which
   * matched any https URL, enabling CWE-601 open-redirect / authorization-code
   * theft. Do not loosen the default beyond loopback addresses.
   */
  private validateRedirectUri(uri: string): boolean {
    let url: URL;

    try {
      url = new URL(uri); // throws on malformed input
    } catch {
      return false;
    }

    // Userinfo has no legitimate use in a redirect URI, and every use of it is
    // an attempt to make one host read as another: `http://localhost:@evil.com`
    // navigates to evil.com. Refuse it outright rather than rely on each
    // pattern to be written defensively.
    if (url.username !== "" || url.password !== "") {
      return false;
    }

    const patterns = this.config.allowedRedirectUriPatterns;

    // Explicitly set to empty array → strict mode, reject everything.
    if (Array.isArray(patterns) && patterns.length === 0) {
      return false;
    }

    // Not configured → localhost-only default (covers MCP dynamic loopback ports).
    const effectivePatterns = patterns ?? [
      "http://localhost:*",
      "http://127.0.0.1:*",
    ];

    return effectivePatterns.some((pattern) =>
      this.matchesPattern(url, pattern),
    );
  }
}

/**
 * One component of an allow-list pattern, compiled to an anchored RegExp where
 * `*` spans any run of characters and `?` exactly one.
 *
 * Every other character is escaped, using the canonical set from MDN's
 * `escapeRegExp`. Left raw, a `.` would reach the RegExp as "any character", so
 * a pattern written for one host would also admit a lookalike an attacker can
 * register. Escaping and wildcard expansion happen in one pass, so a backslash
 * this inserts can never be re-read as the metacharacter of a later pass.
 */
const globComponent = (glob: string): RegExp => {
  const source = glob.replace(/[.*+?^${}()|[\]\\]/g, (character) => {
    if (character === "*") {
      return ".*";
    }

    if (character === "?") {
      return ".";
    }

    return `\\${character}`;
  });

  return new RegExp(`^${source}$`);
};

/**
 * An allow-list pattern split into the URI components it constrains.
 *
 * `authority` is null for a private-use scheme with no `//` (RFC 8252 §7.1,
 * e.g. `com.example.app:/callback`); `rest` is empty when the pattern
 * constrains scheme, host and port only.
 */
type UriPattern = {
  authority: { host: string; port: string } | null;
  rest: string;
  scheme: string;
};

/**
 * Split a pattern into components without `new URL()`, which rejects the
 * wildcards the patterns exist to express — `http://localhost:*` throws,
 * because `*` is not a valid port.
 *
 * Returns null for a pattern that cannot be honoured safely, which then matches
 * nothing: a pattern that fails to parse must never fall back to matching more
 * than it should.
 */
const parseUriPattern = (pattern: string): null | UriPattern => {
  const schemeEnd = pattern.indexOf(":");

  if (schemeEnd <= 0) {
    return null;
  }

  const scheme = pattern.slice(0, schemeEnd).toLowerCase();
  const afterScheme = pattern.slice(schemeEnd + 1);

  if (!afterScheme.startsWith("//")) {
    return { authority: null, rest: afterScheme, scheme };
  }

  const hierarchical = afterScheme.slice(2);
  const restStart = hierarchical.search(/[#/?]/);
  const authority =
    restStart === -1 ? hierarchical : hierarchical.slice(0, restStart);

  // Userinfo is never legitimate in a redirect URI, and a pattern carrying it
  // could only ever be a mistake — reject rather than guess at the intent.
  if (authority.includes("@")) {
    return null;
  }

  // An IPv6 literal is bracketed and full of colons, so the port separator is
  // the first colon *after* the closing bracket. An unclosed bracket falls back
  // to 0 and yields a host that matches nothing, which is the safe direction.
  const hostEnd = authority.startsWith("[") ? authority.indexOf("]") + 1 : 0;
  const portSeparator = authority.indexOf(":", hostEnd);

  return {
    authority: {
      host: (portSeparator === -1
        ? authority
        : authority.slice(0, portSeparator)
      ).toLowerCase(),
      port: portSeparator === -1 ? "" : authority.slice(portSeparator + 1),
    },
    rest: restStart === -1 ? "" : hierarchical.slice(restStart),
    scheme,
  };
};

/**
 * OAuth Proxy Error
 */
/**
 * True for redirect URIs a natively-installed app would use: loopback HTTP (an
 * ephemeral local port) or a private-use scheme. Used to infer
 * `application_type` when a client does not declare one.
 */
const isLoopbackRedirectUri = (uri: string): boolean => {
  try {
    const url = new URL(uri);

    if (url.protocol === "http:" || url.protocol === "https:") {
      return isLoopbackHostname(url.hostname);
    }

    // A private-use URI scheme (e.g. "com.example.app:/callback").
    return url.protocol !== "";
  } catch {
    return false;
  }
};

/**
 * A client that holds no secret: one resolved from a Client ID Metadata
 * Document, or one registered with `token_endpoint_auth_method: "none"`.
 *
 * A registration that predates recorded auth methods is not one of these. It
 * was issued a secret and may still use it, so it is held to the public-client
 * rules only when it leaves that secret out.
 */
const isPublicClient = (client: ProxyDCRClient): boolean =>
  client.source === "cimd" || client.tokenEndpointAuthMethod === "none";

/** How an error message names a client that has not authenticated. */
const describeUnauthenticatedClient = (client: ProxyDCRClient): string => {
  if (client.source === "cimd") {
    return "Client ID Metadata Document clients";
  }

  if (client.tokenEndpointAuthMethod === "none") {
    return 'clients registered with token_endpoint_auth_method "none"';
  }

  return "clients that do not authenticate with their client_secret";
};

const isTokenEndpointAuthMethod = (
  value: string,
): value is TokenEndpointAuthMethod =>
  (TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(value);

/**
 * Constant-time secret comparison (CWE-208). Comparing digests keeps both
 * sides the same length, so `timingSafeEqual` neither throws on a mismatch nor
 * reveals how long the expected secret is.
 */
const secretsMatch = (presented: string, expected: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(expected).digest(),
  );

export class OAuthProxyError extends Error {
  constructor(
    public code: string,
    public description?: string,
    public statusCode: number = 400,
  ) {
    super(code);
    this.name = "OAuthProxyError";
  }

  toJSON(): OAuthError {
    return {
      error: this.code,
      error_description: this.description,
    };
  }

  toResponse(): Response {
    return new Response(JSON.stringify(this.toJSON()), {
      headers: { "Content-Type": "application/json" },
      status: this.statusCode,
    });
  }
}
