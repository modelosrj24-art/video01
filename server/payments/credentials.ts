import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { GatewayEnvironment, GatewayId, GatewayRuntimeConfig } from './types.ts';

const EPHEMERAL_AES_KEY = crypto.randomBytes(32);

function deriveEncryptionKey(): Buffer {
  const raw =
    process.env.GATEWAY_ENCRYPTION_KEY?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    '';
  if (raw.length >= 16) {
    return crypto.createHash('sha256').update(`aurum-gateway-key:${raw}`).digest();
  }
  return EPHEMERAL_AES_KEY;
}

export function encryptGatewayCredentials(creds: Record<string, string>): string {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) {
    if (typeof v === 'string' && v.trim()) {
      cleaned[k] = v.trim();
    }
  }
  const iv = crypto.randomBytes(12);
  const key = deriveEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(cleaned), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

export function decryptGatewayCredentials(stored: string | null | undefined): Record<string, string> {
  if (!stored || stored === '{}') return {};
  try {
    const parsed = JSON.parse(stored) as { v?: number; iv?: string; tag?: string; data?: string };
    if (!parsed.iv || !parsed.tag || !parsed.data) return {};
    const key = deriveEncryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(parsed.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(decrypted) as Record<string, string>;
  } catch {
    return {};
  }
}

function mergeEnvCredentials(gatewayId: GatewayId, storedCreds: Record<string, string>): Record<string, string> {
  if (gatewayId === 'mercadopago') {
    return {
      accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN?.trim() || storedCreds.accessToken || '',
      publicKey: process.env.MERCADOPAGO_PUBLIC_KEY?.trim() || storedCreds.publicKey || '',
      webhookSecret: process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim() || storedCreds.webhookSecret || '',
      collectorId: process.env.MERCADOPAGO_COLLECTOR_ID?.trim() || storedCreds.collectorId || '',
    };
  }
  if (gatewayId === 'paypal') {
    return {
      clientId: process.env.PAYPAL_CLIENT_ID?.trim() || storedCreds.clientId || '',
      clientSecret: process.env.PAYPAL_CLIENT_SECRET?.trim() || storedCreds.clientSecret || '',
      webhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() || storedCreds.webhookId || '',
      merchantId: process.env.PAYPAL_MERCHANT_ID?.trim() || storedCreds.merchantId || '',
    };
  }
  return { ...storedCreds };
}

export function loadGatewayRuntimeConfig(db: Database.Database, gatewayId: GatewayId): GatewayRuntimeConfig | null {
  const row = db.prepare('SELECT * FROM payment_gateways WHERE id = ?').get(gatewayId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const stored = decryptGatewayCredentials(String(row.encrypted_credentials || '{}'));
  const credentials = mergeEnvCredentials(gatewayId, stored);

  const hasLiveCredentials =
    gatewayId === 'mercadopago'
      ? Boolean(credentials.accessToken)
      : gatewayId === 'paypal'
        ? Boolean(credentials.clientId && credentials.clientSecret)
        : Object.values(credentials).some(Boolean);

  let supportedMethods: string[] = [];
  let supportedCurrencies: string[] = ['BRL'];
  try {
    supportedMethods = JSON.parse(String(row.supported_methods || '[]'));
  } catch {
    supportedMethods = [];
  }
  try {
    supportedCurrencies = JSON.parse(String(row.supported_currencies || '["BRL"]'));
  } catch {
    supportedCurrencies = ['BRL'];
  }

  return {
    id: String(row.id),
    displayName: String(row.display_name),
    isEnabled: Boolean(row.is_enabled),
    environment: (String(row.environment) === 'production' ? 'production' : 'sandbox') as GatewayEnvironment,
    supportedMethods,
    supportedCurrencies,
    splitEnabled: Boolean(row.split_enabled),
    complianceVerified: Boolean(row.compliance_verified),
    credentials,
    hasLiveCredentials,
  };
}

export function maskGatewayCredentials(gatewayId: GatewayId, creds: Record<string, string>) {
  const mask = (val?: string) => {
    if (!val) return null;
    if (val.length <= 6) return '••••••';
    return `••••${val.slice(-4)}`;
  };

  if (gatewayId === 'mercadopago') {
    return {
      hasAccessToken: Boolean(creds.accessToken),
      accessTokenHint: mask(creds.accessToken),
      hasPublicKey: Boolean(creds.publicKey),
      publicKeyHint: mask(creds.publicKey),
      hasWebhookSecret: Boolean(creds.webhookSecret),
      webhookSecretHint: mask(creds.webhookSecret),
      fromEnv: Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN?.trim()),
    };
  }
  if (gatewayId === 'paypal') {
    return {
      hasClientId: Boolean(creds.clientId),
      clientIdHint: mask(creds.clientId),
      hasClientSecret: Boolean(creds.clientSecret),
      clientSecretHint: mask(creds.clientSecret),
      hasWebhookId: Boolean(creds.webhookId),
      webhookIdHint: mask(creds.webhookId),
      fromEnv: Boolean(process.env.PAYPAL_CLIENT_ID?.trim() && process.env.PAYPAL_CLIENT_SECRET?.trim()),
    };
  }
  return {};
}
