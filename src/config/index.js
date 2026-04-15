import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.ENV_FILE || `.env.${process.env.NODE_ENV || 'development'}`;
const resolvedPath = path.resolve(__dirname, '..', '..', envFile);

dotenv.config({ path: resolvedPath });

const parseDemoTokens = (list = '') =>
  list
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [token, role, fullName, email] = entry.split(':');
      return {
        token: token?.trim(),
        role: role?.trim(),
        fullName: fullName?.trim(),
        email: email?.trim()
      };
    })
    .filter((item) => item.token && item.email);

const parseJson = (value) => {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn('Failed to parse JSON value, falling back to object', error?.message);
    return {};
  }
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4000,
  databaseUrl: process.env.DATABASE_URL,
  serviceToken: process.env.SERVICE_TOKEN,
  demoPassword: process.env.DEMO_PASSWORD,
  demoUsers: parseDemoTokens(process.env.DEMO_TOKENS),
  appId: process.env.APP_ID,
  publicSettings: parseJson(process.env.APP_PUBLIC_SETTINGS),
  logLevel: process.env.LOG_LEVEL || 'info',
  keycloakUrl: process.env.KEYCLOAK_URL || process.env.VITE_KEYCLOAK_URL,
  // Multi-realm login configuration
  keycloakScope: process.env.KEYCLOAK_SCOPE || 'openid',
  keycloakRealmBrins: process.env.KEYCLOAK_REALM_BRINS || 'brins',
  keycloakRealmTugure: process.env.KEYCLOAK_REALM_TUGURE || 'tugure',
  keycloakClientIdBrins: process.env.KEYCLOAK_CLIENT_ID_BRINS,
  keycloakClientSecretBrins: process.env.KEYCLOAK_CLIENT_SECRET_BRINS,
  keycloakClientIdTugure: process.env.KEYCLOAK_CLIENT_ID_TUGURE,
  keycloakClientSecretTugure: process.env.KEYCLOAK_CLIENT_SECRET_TUGURE,
  // Path ke file PEM CA untuk sertifikat Keycloak yang self-signed / internal CA.
  // Di production dengan CA publik (Let's Encrypt dsb.), biarkan kosong.
  keycloakCaCert: (() => {
    const certPath = process.env.KEYCLOAK_CA_CERT_PATH;
    if (!certPath) return null;
    const resolved = path.resolve(__dirname, '..', '..', certPath);
    try {
      return fs.readFileSync(resolved);
    } catch (err) {
      console.warn(`[config] KEYCLOAK_CA_CERT_PATH="${certPath}" could not be read: ${err.message}`);
      return null;
    }
  })(),
  frontendUrl: process.env.FRONTEND_URL || process.env.VITE_KEYCLOAK_REDIRECT_URI ,
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.SMTP_FROM_NAME,
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT,
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
    bucket: process.env.MINIO_BUCKET,
    region: process.env.AWS_REGION,
  },
  // Signature validation (HMAC-SHA256)
  // SIGNATURE_TOLERANCE_MS / SIGNATURE_MAX_AGE_MS: expiry window in ms (default 5 seconds)
  // SIGNATURE_SECRET: shared secret; must match VITE_SIGNATURE_SECRET / VITE_KEYCLOAK_SECRET_KEY on frontend
  signatureToleranceMs: Number(process.env.SIGNATURE_TOLERANCE_MS) || Number(process.env.SIGNATURE_MAX_AGE_MS) || 5000,
  signatureSecret: process.env.SIGNATURE_SECRET || process.env.KEYCLOAK_SECRET_KEY || '',
};

export default config;
