import { randomUUID, createHash, randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import { URL } from 'url';
import { OAuth2Client, Credentials } from 'google-auth-library';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive.file',
];
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

const isAzure = process.env.AZURE_DEPLOYMENT === 'true';

// Per-session OAuth2 clients (keyed by auth session ID)
const sessionClients = new Map<string, OAuth2Client>();

// Pending Web OAuth states: state UUID → session ID (manual authorize_gmail tool)
const pendingOAuthStates = new Map<string, string>();

// ── MCP Authorization flow (RFC 6749 / MCP spec 2025-03) ──────────────────────

interface PendingMcpFlow {
  sessionId: string;
  mcpRedirectUri: string;
  mcpState: string;
  codeChallenge: string;   // PKCE S256
}

// googleState → MCP flow (in-flight Google OAuth for MCP client)
const pendingMcpFlows = new Map<string, PendingMcpFlow>();

// mcpAuthCode → { sessionId, codeChallenge, redirectUri }
const pendingMcpCodes = new Map<string, {
  sessionId: string;
  codeChallenge: string;
  redirectUri: string;
  bearerToken: string;
}>();

// bearer token → auth session ID
const bearerTokens = new Map<string, string>();

// Per-user schedule bearer tokens (bearer → email, persisted in Key Vault)
const scheduleTokenMap = new Map<string, string>();
// Per-user schedule OAuth clients (email → client, lazy-loaded from Key Vault)
const scheduleClients = new Map<string, OAuth2Client>();

// ── Azure Key Vault helpers ────────────────────────────────────────────────────

function getKeyVaultClient(): SecretClient {
  const kvUrl = process.env.AZURE_KEY_VAULT_URL;
  if (!kvUrl) throw new Error('AZURE_KEY_VAULT_URL is not set');
  return new SecretClient(kvUrl, new DefaultAzureCredential());
}

async function getRefreshTokenFromKeyVault(): Promise<string> {
  const client = getKeyVaultClient();
  const secret = await client.getSecret('gmail-refresh-token');
  if (!secret.value) throw new Error('Secret "gmail-refresh-token" is empty in Key Vault');
  return secret.value;
}

function isKeyVaultSecretNotFound(err: unknown): boolean {
  const e = err as { statusCode?: number; code?: string } | null;
  return e?.statusCode === 404 || e?.code === 'SecretNotFound';
}

export async function saveRefreshTokenToKeyVault(refreshToken: string): Promise<void> {
  const client = getKeyVaultClient();
  await client.setSecret('gmail-refresh-token', refreshToken);
  console.error('refresh_token saved to Key Vault.');
}

// ── Per-user schedule token helpers ───────────────────────────────────────────

async function loadScheduleMap(): Promise<Map<string, string>> {
  try {
    const kv = getKeyVaultClient();
    const secret = await kv.getSecret('gmail-schedule-map');
    if (!secret.value) return new Map();
    return new Map(Object.entries(JSON.parse(secret.value) as Record<string, string>));
  } catch (err) {
    if (isKeyVaultSecretNotFound(err)) return new Map();
    throw err;
  }
}

async function persistScheduleMap(map: Map<string, string>): Promise<void> {
  const kv = getKeyVaultClient();
  await kv.setSecret('gmail-schedule-map', JSON.stringify(Object.fromEntries(map)));
}

async function saveUserRefreshToken(sanitizedEmail: string, refreshToken: string): Promise<void> {
  const kv = getKeyVaultClient();
  await kv.setSecret(`gmail-refresh-token-${sanitizedEmail}`, refreshToken);
}

function sanitizeEmail(email: string): string {
  return email.replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

async function getUserRefreshToken(sanitizedEmail: string): Promise<string | null> {
  try {
    const kv = getKeyVaultClient();
    const secret = await kv.getSecret(`gmail-refresh-token-${sanitizedEmail}`);
    return secret.value ?? null;
  } catch (err) {
    if (isKeyVaultSecretNotFound(err)) return null;
    throw err;
  }
}

async function getAuthenticatedEmail(client: OAuth2Client): Promise<string> {
  const { google } = await import('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  if (!profile.data.emailAddress) throw new Error('Could not resolve authorized Gmail account');
  return profile.data.emailAddress;
}

async function persistAuthorizedClient(
  sessionClient: OAuth2Client,
): Promise<{ token: string; email: string }> {
  const email = await getAuthenticatedEmail(sessionClient);
  const sanitized = sanitizeEmail(email);
  const refreshToken =
    sessionClient.credentials.refresh_token ??
    await getUserRefreshToken(sanitized);

  if (!refreshToken) {
    throw new Error(
      `Google did not return a refresh token for ${email}. Revoke the app in Google Account permissions, then authorize again.`
    );
  }

  if (!sessionClient.credentials.refresh_token) {
    sessionClient.setCredentials({ ...sessionClient.credentials, refresh_token: refreshToken });
  }

  await saveUserRefreshToken(sanitized, refreshToken);

  const map = await loadScheduleMap();
  const existing = [...map.entries()].find(([, e]) => e === email);
  const token = existing?.[0] ?? randomBytes(32).toString('hex');
  map.set(token, email);
  await persistScheduleMap(map);

  scheduleTokenMap.set(token, email);
  scheduleClients.set(email, sessionClient);
  return { token, email };
}

async function getOrCreateScheduleClient(email: string): Promise<OAuth2Client> {
  if (scheduleClients.has(email)) return scheduleClients.get(email)!;
  const sanitized = sanitizeEmail(email);
  const refreshToken = await getUserRefreshToken(sanitized);
  if (!refreshToken) throw new Error(`No refresh token found for ${email}; please authorize again.`);
  const { clientId, clientSecret } = loadWebCredentials();
  const client = new OAuth2Client(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  client.on('tokens', async (tokens) => {
    if (tokens.refresh_token) await saveUserRefreshToken(sanitized, tokens.refresh_token).catch(() => {});
  });
  scheduleClients.set(email, client);
  return client;
}

// ── Credential loaders ─────────────────────────────────────────────────────────

/** Desktop/installed app credentials — used for Key Vault fallback & local setup */
function loadCredentials(): { clientId: string; clientSecret: string } {
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars not set');
}

/** Web application credentials — used for per-user redirect OAuth on Azure */
function loadWebCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_WEB_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_WEB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_WEB_CLIENT_ID / GOOGLE_WEB_CLIENT_SECRET env vars not set');
  }
  return { clientId, clientSecret };
}

function getOAuthCallbackUrl(): string {
  return process.env.OAUTH_CALLBACK_URL ??
    'https://gmail-pdf-mcp.livelymoss-77bbcaee.eastasia.azurecontainerapps.io/oauth2callback';
}

// ── Azure mode: Key Vault refresh_token (admin-set fallback) ───────────────────

async function getAzureOAuth2Client(): Promise<OAuth2Client> {
  const { clientId, clientSecret } = loadCredentials();
  const client = new OAuth2Client(clientId, clientSecret);
  const refreshToken = await getRefreshTokenFromKeyVault();
  client.setCredentials({ refresh_token: refreshToken });
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) saveRefreshTokenToKeyVault(tokens.refresh_token).catch(() => {});
  });
  return client;
}

// ── Local mode: interactive OAuth2 + token.json ────────────────────────────────

async function loadLocalToken(): Promise<Credentials | null> {
  try {
    return JSON.parse(await fs.readFile(TOKEN_PATH, 'utf-8')) as Credentials;
  } catch { return null; }
}

async function saveLocalToken(credentials: Credentials): Promise<void> {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(credentials, null, 2), 'utf-8');
}

async function buildOAuth2Client(): Promise<OAuth2Client> {
  try {
    const { clientId, clientSecret } = loadCredentials();
    return new OAuth2Client(clientId, clientSecret, 'http://localhost:3000/oauth2callback');
  } catch {
    const { installed } = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf-8'));
    return new OAuth2Client(installed.client_id, installed.client_secret, 'http://localhost:3000/oauth2callback');
  }
}

async function runInteractiveOAuth(client: OAuth2Client): Promise<Credentials> {
  const port = parseInt(process.env.OAUTH_PORT ?? '3000', 10);
  const authUrl = client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  const { default: open } = await import('open');
  console.error('Opening browser for Gmail OAuth2 authorization...');
  await open(authUrl);
  console.error(`If browser did not open, visit:\n${authUrl}`);

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/oauth2callback')) return;
      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>授權完成，可以關閉此分頁。</h1>');
      server.close();
      if (error || !code) { reject(new Error(`OAuth error: ${error ?? 'no code'}`)); return; }
      try { const { tokens } = await client.getToken(code); resolve(tokens); }
      catch (err) { reject(err); }
    });
    server.listen(port, () => console.error(`Waiting for OAuth2 callback on port ${port}...`));
    server.on('error', reject);
  });
}

async function getLocalOAuth2Client(): Promise<OAuth2Client> {
  const client = await buildOAuth2Client();
  const saved = await loadLocalToken();
  if (saved) {
    client.setCredentials(saved);
    client.on('tokens', (tokens) => saveLocalToken({ ...saved, ...tokens }).catch(() => {}));
    return client;
  }
  const tokens = await runInteractiveOAuth(client);
  await saveLocalToken(tokens);
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => saveLocalToken({ ...tokens, ...newTokens }).catch(() => {}));
  return client;
}

// ── Web OAuth redirect flow (per-user, Azure mode) ─────────────────────────────

/**
 * Generate a Google OAuth URL for the session. The redirect goes back to
 * the Container App's /oauth2callback route.
 */
export function generateWebAuthUrl(sessionId: string): string {
  const { clientId, clientSecret } = loadWebCredentials();
  const callbackUrl = getOAuthCallbackUrl();
  const client = new OAuth2Client(clientId, clientSecret, callbackUrl);

  const state = randomUUID();
  pendingOAuthStates.set(state, sessionId);
  // Auto-expire state after 30 minutes
  setTimeout(() => pendingOAuthStates.delete(state), 30 * 60 * 1000);

  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  });
}

/**
 * Called by the /oauth2callback Express route to exchange the code for tokens
 * and store them for the associated session.
 */
export async function completeOAuthCallback(state: string, code: string): Promise<void> {
  const sessionId = pendingOAuthStates.get(state);
  if (!sessionId) throw new Error('Invalid or expired authorization state. Please call authorize_gmail again.');
  pendingOAuthStates.delete(state);

  const { clientId, clientSecret } = loadWebCredentials();
  const callbackUrl = getOAuthCallbackUrl();
  const client = new OAuth2Client(clientId, clientSecret, callbackUrl);

  const { tokens } = await client.getToken(code);
  if (!tokens.access_token && !tokens.refresh_token) throw new Error('No tokens returned from Google');

  client.setCredentials(tokens);
  sessionClients.set(sessionId, client);
  console.error(`[auth] Session ${sessionId.slice(0, 8)} authorized via Web OAuth`);
}

export function getSessionAuthStatus(sessionId: string): 'authorized' | 'pending' | 'none' {
  if (sessionClients.has(sessionId)) return 'authorized';
  if (sessionId === 'static' || sessionId.startsWith('schedule:')) return 'authorized';
  // Check if there's a pending state for this session
  for (const sid of pendingOAuthStates.values()) {
    if (sid === sessionId) return 'pending';
  }
  return 'none';
}

// ── MCP Authorization helpers ──────────────────────────────────────────────────

/**
 * Start an MCP Authorization flow: create a fresh session, record the MCP
 * client's PKCE challenge and redirect URI, then return the Google OAuth URL.
 */
export function startMcpOAuthFlow(params: {
  mcpRedirectUri: string;
  mcpState: string;
  codeChallenge: string;
}): string {
  const sessionId = randomUUID();
  const googleState = randomUUID();

  pendingMcpFlows.set(googleState, {
    sessionId,
    mcpRedirectUri: params.mcpRedirectUri,
    mcpState: params.mcpState,
    codeChallenge: params.codeChallenge,
  });
  setTimeout(() => pendingMcpFlows.delete(googleState), 10 * 60 * 1000);

  const { clientId, clientSecret } = loadWebCredentials();
  const client = new OAuth2Client(clientId, clientSecret, getOAuthCallbackUrl());
  return client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent', state: googleState });
}

/**
 * Called from /oauth2callback. If the state belongs to an MCP flow, exchange
 * the Google code for tokens, issue our own one-time auth code, and return the
 * redirect info so the caller can send the user back to the MCP client.
 * Returns null if the state belongs to the manual authorize_gmail tool instead.
 */
export async function completeMcpOAuthCallback(
  googleState: string,
  googleCode: string,
): Promise<{ mcpRedirectUri: string; mcpState: string; mcpAuthCode: string } | null> {
  const flow = pendingMcpFlows.get(googleState);
  if (!flow) return null;
  pendingMcpFlows.delete(googleState);

  const { clientId, clientSecret } = loadWebCredentials();
  const client = new OAuth2Client(clientId, clientSecret, getOAuthCallbackUrl());
  const { tokens } = await client.getToken(googleCode);
  client.setCredentials(tokens);
  sessionClients.set(flow.sessionId, client);
  const persisted = await persistAuthorizedClient(client);
  console.error(`[auth] Session ${flow.sessionId.slice(0, 8)} authorized via MCP OAuth flow for ${persisted.email}`);

  const mcpAuthCode = randomBytes(32).toString('hex');
  pendingMcpCodes.set(mcpAuthCode, {
    sessionId: flow.sessionId,
    codeChallenge: flow.codeChallenge,
    redirectUri: flow.mcpRedirectUri,
    bearerToken: persisted.token,
  });
  setTimeout(() => pendingMcpCodes.delete(mcpAuthCode), 5 * 60 * 1000);

  return { mcpRedirectUri: flow.mcpRedirectUri, mcpState: flow.mcpState, mcpAuthCode };
}

/**
 * Token endpoint handler: verify PKCE and redirect_uri, then issue a bearer token.
 * Returns the bearer token string on success, or null on failure.
 */
export function exchangeMcpCode(code: string, codeVerifier: string, redirectUri: string): string | null {
  const pending = pendingMcpCodes.get(code);
  if (!pending) return null;

  const expected = createHash('sha256').update(codeVerifier).digest('base64url');
  if (expected !== pending.codeChallenge || redirectUri !== pending.redirectUri) return null;

  pendingMcpCodes.delete(code);

  if (!scheduleTokenMap.has(pending.bearerToken)) {
    bearerTokens.set(pending.bearerToken, pending.sessionId);
  }
  return pending.bearerToken;
}

/** Validate a bearer token. Returns the auth session ID or null. */
export function validateBearerToken(token: string): string | null {
  const staticToken = process.env.STATIC_BEARER_TOKEN;
  if (staticToken && token === staticToken) return 'static';
  const scheduleEmail = scheduleTokenMap.get(token);
  if (scheduleEmail) return `schedule:${scheduleEmail}`;
  return bearerTokens.get(token) ?? null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns an OAuth2 client for the session:
 * 1. 'static' → Key Vault deployer account (STATIC_BEARER_TOKEN)
 * 2. 'schedule:{email}' → per-user Key Vault refresh token (save_schedule_token)
 * 3. UUID session → per-user Web OAuth client (interactive browser flow)
 * 4. Fallback → Key Vault / local token.json
 */
export async function getAuthClientForSession(sessionId: string): Promise<OAuth2Client> {
  if (sessionId === 'static') return isAzure ? getAzureOAuth2Client() : getLocalOAuth2Client();
  if (sessionId.startsWith('schedule:')) return getOrCreateScheduleClient(sessionId.slice(9));
  if (sessionClients.has(sessionId)) return sessionClients.get(sessionId)!;
  return isAzure ? getAzureOAuth2Client() : getLocalOAuth2Client();
}

/** Backward-compatible shorthand (used by setup scripts) */
export async function getAuthClient(): Promise<OAuth2Client> {
  return isAzure ? getAzureOAuth2Client() : getLocalOAuth2Client();
}

/**
 * Called after a bearer token is issued to automatically persist the user's
 * credentials to Key Vault. Fire-and-forget — does not block the token response.
 * After this runs, the token survives server restarts and can be used for
 * scheduled tasks without re-authorization.
 */
export async function autoPersistBearerToken(token: string): Promise<void> {
  if (!isAzure) return;
  const sessionId = bearerTokens.get(token);
  if (!sessionId) return;
  const sessionClient = sessionClients.get(sessionId);
  if (!sessionClient?.credentials.refresh_token) return;
  if (scheduleTokenMap.has(token)) return; // already persisted

  const { google } = await import('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: sessionClient });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress!;
  const sanitized = email.replace(/[^a-z0-9]/gi, '-').toLowerCase();

  await saveUserRefreshToken(sanitized, sessionClient.credentials.refresh_token);
  const map = await loadScheduleMap();
  map.set(token, email);
  await persistScheduleMap(map);
  scheduleTokenMap.set(token, email);
  scheduleClients.set(email, sessionClient);
  console.error(`[auth] Auto-persisted credentials for ${email}`);
}

/**
 * Load all per-user schedule tokens from Key Vault into memory.
 * Called once at server startup in Azure mode.
 */
export async function initScheduleTokens(): Promise<void> {
  if (!isAzure) return;
  try {
    const map = await loadScheduleMap();
    for (const [token, email] of map) scheduleTokenMap.set(token, email);
    console.error(`[auth] Loaded ${map.size} per-user schedule token(s) from Key Vault`);
  } catch (e) {
    console.error('[auth] Failed to load schedule tokens from Key Vault:', e);
  }
}

/**
 * Save the current session's refresh token to Key Vault and issue a
 * permanent per-user static bearer token for use in scheduled tasks.
 * Returns the bearer token and the user's email address.
 */
export async function saveScheduleToken(
  sessionId: string,
): Promise<{ token: string; email: string }> {
  const sessionClient = sessionClients.get(sessionId);
  if (!sessionClient) throw new Error('No active session — please authorize via browser first.');

  const refreshToken = sessionClient.credentials.refresh_token;
  if (!refreshToken) throw new Error('Session has no refresh token. Please re-authorize (revoke and re-connect).');

  const { google } = await import('googleapis');
  const gmail = google.gmail({ version: 'v1', auth: sessionClient });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress!;
  const sanitized = email.replace(/[^a-z0-9]/gi, '-').toLowerCase();

  await saveUserRefreshToken(sanitized, refreshToken);

  const map = await loadScheduleMap();
  // Reuse existing token for this email if one already exists
  const existing = [...map.entries()].find(([, e]) => e === email);
  const token = existing?.[0] ?? randomBytes(32).toString('hex');
  map.set(token, email);
  await persistScheduleMap(map);
  scheduleTokenMap.set(token, email);
  // Pre-cache the client so the first scheduled call doesn't hit KV
  scheduleClients.set(email, sessionClient);

  console.error(`[auth] Schedule token saved for ${email}`);
  return { token, email };
}

// Quick standalone test
if (require.main === module) {
  (async () => {
    console.error('Testing auth...');
    const client = await getAuthClient();
    const gmail = (await import('googleapis')).google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.error('Authenticated as:', profile.data.emailAddress);
  })().catch(console.error);
}
