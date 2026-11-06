declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    ADMIN_USERNAME?: string;
    ADMIN_PASSWORD_HASH?: string;
    APP_ORIGIN?: string;
  }
}
