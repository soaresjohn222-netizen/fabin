declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ADMIN_USERNAME?: string;
    ADMIN_PASSWORD_HASH?: string;
    APP_ORIGIN?: string;
    AUTH_PROVIDER?: string;
    AUTH_VERSION?: string;
    STORAGE_PROVIDER?: string;
    SUPABASE_URL?: string;
    SUPABASE_PUBLISHABLE_KEY?: string;
    SUPABASE_SECRET_KEY?: string;
    SUPABASE_ADMIN_EMAIL?: string;
    SUPABASE_ADMIN_ID?: string;
    SUPABASE_STORAGE_BUCKET?: string;
  }
}
