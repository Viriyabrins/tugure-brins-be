#!/usr/bin/env node
import { execSync } from 'child_process'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve env file from ENV_FILE or NODE_ENV
const envFile = process.env.ENV_FILE || `.env.${process.env.NODE_ENV || 'development'}`
const resolvedPath = path.resolve(__dirname, '..', envFile)
dotenv.config({ path: resolvedPath })

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('Usage: node script/prisma-run.js <prisma-args...>')
  process.exit(1)
}

const cmd = `npx prisma ${args.join(' ')}`
try {
  execSync(cmd, { stdio: 'inherit' })
} catch (err) {
  process.exit(err.status || 1)
}
