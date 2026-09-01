/**
 * Reads a `.env` from the working directory into `process.env`. It has to run
 * before anything reads a variable, because the loader evaluates the
 * `!!js process.env.*` expressions in cordis.yml while it mounts.
 *
 * Variables that are already set win over the file, so a shell export and
 * compose's `env_file` both stay authoritative. A missing file is not an error:
 * the Docker image ships without one and gets its environment from compose.
 */
import { existsSync } from 'node:fs'

export function loadEnv(path: string = process.env['HOOKY_ENV_FILE'] ?? '.env'): boolean {
  if (!existsSync(path)) return false
  process.loadEnvFile(path)
  return true
}
