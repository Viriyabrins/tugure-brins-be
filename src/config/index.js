import dotenv from 'dotenv';
import path from 'path';
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
  keycloakRealm: process.env.KEYCLOAK_REALM || process.env.VITE_KEYCLOAK_REALM,
  keycloakClientId: process.env.KEYCLOAK_CLIENT_ID || process.env.VITE_KEYCLOAK_CLIENT_ID,
  keycloakClientSecret: process.env.KEYCLOAK_CLIENT_SECRET || process.env.VITE_KEYCLOAK_CLIENT_SECRET,
  frontendUrl: process.env.FRONTEND_URL || process.env.VITE_KEYCLOAK_REDIRECT_URI || 'http://localhost:5173/Dashboard',
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    fromName: process.env.SMTP_FROM_NAME || 'Tugure BRINS System',
  },
};

export default config;
