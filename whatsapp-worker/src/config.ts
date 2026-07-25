function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export const config = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  encryptionKey: required('ENCRYPTION_KEY'),
  workerApiSecret: required('WORKER_API_SECRET'),
  appBaseUrl: required('APP_BASE_URL').replace(/\/$/, ''),
  port: Number(process.env.PORT ?? '3100'),
};
